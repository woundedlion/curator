// Single chokepoint for every Spotify HTTP request.
//
// Composition:
//   apiClient  →  IntervalQueue   (fixed-interval pacer; one in flight)
//              →  CircuitBreaker  (handles 429 recovery)
//
// All outbound traffic must pass through `submitSpotifyRequest` (or
// `submitTokenRequest` for accounts.spotify.com). Both share one
// `IntervalQueue` and one `CircuitBreaker` instance — so it is
// impossible to exceed the configured rate or to slip a request past
// an open breaker, regardless of how many concurrent callers exist or
// how the higher layers schedule work.
//
// Spacing semantics: the queue is a strict-interval pacer (NOT a
// token bucket). Every dispatch sets `nextRunAt = now + intervalMs`,
// so an idle period does not accumulate burst credit — after 10
// minutes idle, the next 4 calls still go out 334 ms apart. This is
// deliberate: Spotify's quota is a rolling 30-second sliding-window
// counter (per-app, per client_id — NOT per user/token), and the
// dashboard explicitly flags burst patterns even when 30s totals
// would be fine. A token bucket would let a burst through and earn
// a multi-hour ban.
//
// Design constraints from real incidents:
//   - The policy is single-shot per submission. No in-call retries.
//     Recovery is the circuit breaker's job (half-open probe).
//     Spotipy users have escalated 1h bans to ~24h by retrying into
//     the penalty window — see github.com/spotipy-dev/spotipy#1158.
//   - Retry-After is NOT in Spotify's `Access-Control-Expose-Headers`,
//     so browser JS reads it as `null` even when the response carried
//     a header on the wire (incidents observed values up to ~24h
//     hidden this way). When a real Retry-After IS readable we honor
//     it; the fallback for the blind (CORS-hidden) case is a 10-minute
//     default — long enough to break the retry-into-ban loop on a
//     hidden multi-hour penalty.
//   - The rate-limit machinery's own state — the queue's spacing
//     window and the breaker's open-until/escalation counters — is
//     persisted to localStorage; a page reload after a heavy burst
//     doesn't reset the spacing (Spotify is still counting against the
//     rolling window) and can't reset an active ban. NOTE: this is
//     ONLY the queue/breaker bookkeeping. OAuth tokens are NOT here —
//     they live in sessionStorage (see tokenStorage.ts); none of the
//     persistence described in this file touches the access/refresh
//     token.

import { getValidAccessToken } from "./authFlow";
import { CircuitBreaker } from "./circuitBreaker";
import { IntervalQueue, type QueueDepthObserver } from "../util/intervalQueue";
import {
  SPOTIFY_API_BASE,
  SPOTIFY_NEXT_ALLOWED_AT_KEY,
  SPOTIFY_REQUEST_TIMEOUT_MS,
} from "../constants";

export { RequestCancelledError } from "../util/intervalQueue";

// --- tuning constants ------------------------------------------------------

const RATE_LIMIT_STATUS = 429;
const UNAUTHORIZED_STATUS = 401;
const FORBIDDEN_STATUS = 403;

// Hard ceiling on outbound request rate. Spotify's per-app per-IP
// quota varies; 180 req/min is the contract we enforce. The queue is
// a strict-interval pacer, so the cap is realized as a fixed gap
// between consecutive sends rather than a burst-allowing token bucket.
const MAX_REQUESTS_PER_MINUTE = 180;
// One send every ceil(60000/180) = 334ms. `ceil` (not floor/round) so
// the realized rate never EXCEEDS 180/min: 334ms admits at most 180
// sends in any 60s window, 333ms would admit 181. This leaves headroom
// for SDK / token refresh / sidebar noise that share the quota.
const MIN_REQUEST_SPACING_MS = Math.ceil(60_000 / MAX_REQUESTS_PER_MINUTE);

// Cap a corrupt/stale persisted spacing timestamp so a bad
// localStorage value can't deadlock the bucket.
const NEXT_ALLOWED_AT_CAP_MS = 60_000;

// Circuit-open bounds. Min is so a "1s" Retry-After doesn't leave us
// essentially open (the half-open probe semantics need real time to
// drain Spotify's window). When Spotify supplies a real Retry-After we
// honor it; only the absence of one falls back to the 10-min default
// below. Max bounds a hostile response — set to 12h because Spotify
// HAS been observed issuing ~12h bans (Retry-After 42578s seen on the
// wire, hidden via CORS) and the breaker's exponential backoff needs
// ceiling room to reach them.
const CIRCUIT_BREAKER_MIN_MS = 5_000;
const CIRCUIT_BREAKER_MAX_MS = 12 * 60 * 60 * 1000;
// MAX_RETRY_AFTER_MS (the Retry-After clamp ceiling, below) MUST equal
// this so a Spotify-supplied multi-hour value is honored without exceeding
// the breaker's open ceiling — derive it from this single source of truth
// rather than re-spelling the 12h literal.

// Pessimistic Retry-After fallback — the DEFAULT applied ONLY when no
// usable Retry-After is available. Spotify hides Retry-After behind
// CORS (not in Access-Control-Expose-Headers), so browser JS reads it
// as null even when the wire carried a multi-hour penalty; in that
// blind case we lock out all outbound traffic for 10 minutes. When a
// real value IS present we honor it instead (see `parseRetryAfter`).
// Persisted to localStorage, so the 10-min default lockout survives a
// browser close/reopen, manual refresh, and hard refresh. Capped at
// the same max as the breaker so a Spotify-supplied multi-hour value
// is honored without exceeding the breaker's ceiling.
const DEFAULT_RETRY_AFTER_SECONDS = 10 * 60;
// Kept identical to CIRCUIT_BREAKER_MAX_MS (single source of truth) — the
// Retry-After clamp ceiling and the breaker's open ceiling are the same
// 12h bound, so a Spotify multi-hour value is honored up to but not beyond
// what the breaker can stay open for.
const MAX_RETRY_AFTER_MS = CIRCUIT_BREAKER_MAX_MS;

// Per-call fetch timeout. Bounded so a hung connection can't keep the
// half-open probe slot indefinitely (without this, a probe that never
// resolves would leave `probeInFlight = true` forever and every
// subsequent caller would fail fast for the rest of the session). Shared
// with authFlow's token-endpoint timeout via constants (one breaker, so
// the two lanes must use the same bound).
const REQUEST_TIMEOUT_MS = SPOTIFY_REQUEST_TIMEOUT_MS;

// --- error types -----------------------------------------------------------

export class SpotifyAuthExpiredError extends Error {
  constructor() {
    super("Spotify session expired");
    this.name = "SpotifyAuthExpiredError";
  }
}

export class SpotifyForbiddenError extends Error {
  readonly path: string;
  constructor(path: string, body: string) {
    super(`Spotify 403 on ${path}: ${body}`);
    this.name = "SpotifyForbiddenError";
    this.path = path;
  }
}

export class SpotifyRateLimitError extends Error {
  readonly retryAfterMs: number;
  constructor(retryAfterMs: number) {
    super("Spotify rate limit — paused");
    this.name = "SpotifyRateLimitError";
    this.retryAfterMs = retryAfterMs;
  }
}

export class SpotifyServerError extends Error {
  readonly status: number;
  readonly path: string;
  constructor(path: string, status: number, body: string) {
    super(`Spotify ${status} on ${path}: ${body}`);
    this.name = "SpotifyServerError";
    this.status = status;
    this.path = path;
  }
}

// Covers the 4xx-and-other unhandled status range — 400 Bad Request,
// 404 Not Found, 405 Method Not Allowed, 409 Conflict, etc. Callers can
// type-check on this rather than groveling through generic `Error`
// messages, and it keeps the typed-error contract complete.
export class SpotifyHttpError extends Error {
  readonly status: number;
  readonly path: string;
  constructor(path: string, status: number, body: string) {
    super(`Spotify ${status} on ${path}: ${body}`);
    this.name = "SpotifyHttpError";
    this.status = status;
    this.path = path;
  }
}

export class SpotifyNetworkError extends Error {
  constructor(cause: unknown) {
    const detail =
      cause instanceof Error ? cause.message : String(cause ?? "unknown");
    super(`Spotify network error: ${detail}`);
    this.name = "SpotifyNetworkError";
  }
}

// --- Retry-After parsing ---------------------------------------------------

// Parse an RFC 9110 §10.2.3 Retry-After (integer delta-seconds OR
// HTTP-date) into milliseconds, or return null when the header is
// absent, unparseable, or names a time at/in the past. A past date is
// reported as "no usable value" rather than "retry now": a clock-skewed
// past date must not short-circuit a backoff straight back into an
// active ban. No clamping or defaulting is applied here — callers layer
// their own default and clamp (Spotify and MusicBrainz differ on both).
export function tryParseRetryAfterMs(
  headerValue: string | null,
  nowMs: number = Date.now(),
): number | null {
  if (!headerValue) return null;
  const trimmed = headerValue.trim();
  if (/^\d+$/.test(trimmed)) {
    // Floor at 0, NOT 1: a legitimate `Retry-After: 0` means "retry now"
    // and must pass through faithfully — this helper documents "no
    // clamping or defaulting." Downstream applies its own floor (Spotify
    // via clampRetryAfterMs / the breaker's minOpenMs; MusicBrainz its
    // own cap), so clamping here would lie to callers that want the raw
    // value.
    return Math.max(0, parseInt(trimmed, 10)) * 1000;
  }
  const dateMs = Date.parse(trimmed);
  if (Number.isFinite(dateMs)) {
    const deltaMs = dateMs - nowMs;
    return deltaMs > 0 ? deltaMs : null;
  }
  return null;
}

export function parseRetryAfter(
  headerValue: string | null,
  nowMs: number = Date.now(),
): number {
  const parsed = tryParseRetryAfterMs(headerValue, nowMs);
  if (parsed !== null) return clampRetryAfterMs(parsed);
  if (headerValue) {
    console.warn(
      "Spotify Retry-After header could not be parsed; defaulting to " +
        `${DEFAULT_RETRY_AFTER_SECONDS}s — raw value:`,
      headerValue,
    );
  }
  return DEFAULT_RETRY_AFTER_SECONDS * 1000;
}

function clampRetryAfterMs(value: number): number {
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(1000, value));
}

function readRetryAfterMs(response: Response, path: string): number {
  const raw = response.headers.get("Retry-After");
  const parsed = parseRetryAfter(raw);
  // `corsHidden: true` signals the most likely cause of a missing
  // header — Spotify SHIPPED Retry-After on the wire but didn't
  // include it in Access-Control-Expose-Headers, so JS sees null.
  // Check the DevTools Network tab if this flag is set; the real
  // Retry-After value disambiguates a routine 429 from a multi-hour
  // sustained-abuse ban.
  console.warn("Spotify 429", {
    path,
    rawRetryAfter: raw,
    corsHidden: raw === null,
    parsedWaitMs: parsed,
  });
  return parsed;
}

// --- shared instances ------------------------------------------------------

const queue = new IntervalQueue({
  intervalMs: MIN_REQUEST_SPACING_MS,
  persistKey: SPOTIFY_NEXT_ALLOWED_AT_KEY,
  persistedCapMs: NEXT_ALLOWED_AT_CAP_MS,
});

const breaker = new CircuitBreaker({
  minOpenMs: CIRCUIT_BREAKER_MIN_MS,
  maxOpenMs: CIRCUIT_BREAKER_MAX_MS,
});

// De-dupe state for the rate-limit toast. We track the magnitude of the
// last window we toasted AND the wall-clock time it expires, deriving the
// reset LAZILY on the next toast attempt rather than holding a pending
// setTimeout. The previous approach scheduled a macrotask up to ~12h out
// to zero `lastReportedRateLimitMs`; a long-lived timer is fragile (it's
// throttled/killed by background-tab and sleep policies, and leaks if the
// page is torn down) and entirely avoidable — we only ever read this
// state from inside pushRateLimitToast, so we can recompute "has the prior
// window elapsed?" on demand.
let lastReportedRateLimitMs = 0;
let lastReportedExpiresAt = 0;

// --- observability ---------------------------------------------------------

/** Depth = queued + in-flight. */
export function getPendingSpotifyRequestCount(): number {
  return queue.depth;
}

/** Subscribe to queue depth changes. Returns an unsubscribe function. */
export function observeSpotifyQueueDepth(
  callback: QueueDepthObserver,
): () => void {
  return queue.observe(callback);
}

export function spotifyCircuitOpenMs(): number {
  return breaker.remainingMs();
}

export function resetSpotifyCircuit(): void {
  // Only the breaker. Wiping the queue's spacing window would let a
  // burst go out before Spotify's quota refilled.
  breaker.reset();
}

// --- toast ----------------------------------------------------------------

function pushRateLimitToast(retryMs: number): void {
  // Lazily expire the prior report: if the window we last toasted has
  // already elapsed, forget it so a fresh (even smaller) penalty toasts
  // again. This replaces the long-lived reset timer.
  const now = Date.now();
  if (now >= lastReportedExpiresAt) lastReportedRateLimitMs = 0;
  if (retryMs <= lastReportedRateLimitMs) return;
  lastReportedRateLimitMs = retryMs;
  lastReportedExpiresAt = now + retryMs;
  const seconds = Math.ceil(retryMs / 1000);
  const friendly =
    seconds < 60
      ? `${seconds}s`
      : seconds < 3600
        ? `${Math.ceil(seconds / 60)} min`
        : `${(seconds / 3600).toFixed(1)} hours`;
  void import("../store/uiStore").then(({ useUiStore }) => {
    useUiStore.getState().pushToast({
      kind: "error",
      message: `Spotify rate-limited — pausing all requests for ${friendly}. Spotify enforces a per-app quota; consider reducing playlist size or waiting it out.`,
    });
  });
}

// --- request submission ----------------------------------------------------

export type SpotifyRequest = {
  path: string;
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: unknown;
  query?: Record<string, string | number | undefined>;
};

// Exported for unit testing. Builds the request path's query string,
// extending any query the path already carries rather than clobbering it.
export function appendQuery(path: string, query?: SpotifyRequest["query"]): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value));
  }
  const queryString = params.toString();
  if (!queryString) return path;
  // A path may already carry its own query string (e.g. a Spotify
  // `next` pagination URL fragment). Unconditionally appending `?` would
  // produce a malformed `path?a=b?c=d`; switch to `&` when a `?` is
  // already present so the extra params extend the existing query.
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}${queryString}`;
}

function buildHeaders(
  accessToken: string,
  hasBody: boolean,
): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
  };
  if (hasBody) headers["Content-Type"] = "application/json";
  return headers;
}

async function sendOnce(
  request: SpotifyRequest,
  clientId: string,
  cancelSignal: AbortSignal,
): Promise<Response> {
  const accessToken = await getValidAccessToken(clientId);
  const url = `${SPOTIFY_API_BASE}${appendQuery(request.path, request.query)}`;
  const hasBody = request.body !== undefined;
  return fetchWithTimeout(
    url,
    {
      method: request.method ?? "GET",
      headers: buildHeaders(accessToken, hasBody),
      body: hasBody ? JSON.stringify(request.body) : undefined,
    },
    cancelSignal,
  );
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  cancelSignal: AbortSignal,
): Promise<Response> {
  // Compose two abort sources: the per-request timeout AND the
  // queue-supplied cancellation signal (raised by `cancelByTag` when
  // the underlying entity is deleted). The combined controller aborts
  // as soon as either source fires.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const forwardCancel = (): void => controller.abort();
  if (cancelSignal.aborted) {
    controller.abort();
  } else {
    cancelSignal.addEventListener("abort", forwardCancel, { once: true });
  }
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (cause) {
    // If cancellation drove the abort, re-throw the AbortError as-is
    // so the queue can translate it to RequestCancelledError; only
    // wrap genuine network failures.
    if (cancelSignal.aborted) throw cause;
    throw new SpotifyNetworkError(cause);
  } finally {
    clearTimeout(timer);
    cancelSignal.removeEventListener("abort", forwardCancel);
  }
}

/**
 * Core submission — wires the queue and breaker around a raw send.
 * NO in-call retries. A 429 trips the breaker and propagates as
 * SpotifyRateLimitError; subsequent callers fail fast until the
 * window expires and the next caller becomes the half-open probe.
 */
async function submitRaw(
  send: (signal: AbortSignal) => Promise<Response>,
  context: {
    path: string;
    tag?: string;
    guard?: () => boolean;
    priority?: number;
  },
): Promise<Response> {
  // Breaker check is synchronous and happens BEFORE enqueueing — a
  // fail-fast caller shouldn't take a queue slot, and a probe must
  // be the one that runs first when the breaker is half-open.
  const slot = breaker.tryAcquire();
  if (slot === "fail-fast") {
    throw new SpotifyRateLimitError(breaker.remainingMs());
  }
  const isProbe = slot === "probe";

  // Outer try/finally so the probe slot is released on every exit
  // path — including queue cancellation (cancelByTag) and guard-fail,
  // which reject the enqueue promise WITHOUT running the task body.
  // An inner-only finally would never fire in those cases, stranding
  // probeInFlight=true and failing every subsequent caller for the
  // rest of the session. releaseProbe() is idempotent w.r.t. close(),
  // so the success path (where close() also clears probeInFlight via
  // its own reset) remains correct.
  try {
    return await queue.enqueue(async (signal) => {
      // Half-open invariant — how "only the probe runs when half-open" is
      // actually enforced:
      //   1. Slot selection is SYNCHRONOUS at submit time (tryAcquire,
      //      above, before enqueue). While the breaker is open every
      //      non-probe gets "fail-fast" and never enqueues; while
      //      half-open the FIRST caller gets "probe" and all others get
      //      "fail-fast" (probeInFlight guards it). So a non-probe task
      //      sitting in this queue can only have acquired "pass" — i.e.
      //      the breaker was CLOSED when it was admitted.
      //   2. This re-check then covers the one remaining race: the
      //      breaker may have TRIPPED (full-open) while this non-probe
      //      task waited its turn. remainingMs() > 0 means full-open
      //      (during half-open openUntil is in the past, so remainingMs()
      //      is 0 — a half-open non-probe can't exist here per step 1, so
      //      reading 0 then is not a hole in the invariant).
      // Net: the timing check is NOT what keeps non-probes out during
      // half-open — synchronous slot selection is. This guard exists for
      // the trip-while-queued case.
      if (!isProbe && breaker.remainingMs() > 0) {
        throw new SpotifyRateLimitError(breaker.remainingMs());
      }

      const response = await send(signal);
      if (response.status !== RATE_LIMIT_STATUS) {
        if (isProbe) breaker.close();
        return response;
      }

      const retryMs = readRetryAfterMs(response, context.path);
      // Trip first, then toast the breaker's ACTUAL open window: escalation
      // (consecutive 429s double the wait) and the minOpenMs clamp mean the
      // realized lockout can exceed the raw Retry-After, so reporting
      // `retryMs` would understate how long requests are actually paused.
      breaker.trip(retryMs);
      pushRateLimitToast(breaker.remainingMs());
      // No `queue.recordExternalPause` here. The breaker is the
      // authoritative cool-off — every queued/future caller checks
      // it and fails fast. If we also pushed the queue's next-run-at
      // forward by retryMs, pending tasks would sit in the queue for
      // the entire ban window before they could even reach the
      // breaker check, masking the fail-fast as a timeout.
      throw new SpotifyRateLimitError(retryMs);
    }, { tag: context.tag, guard: context.guard, priority: context.priority });
  } finally {
    if (isProbe) breaker.releaseProbe();
  }
}

export type SubmitOptions = {
  /**
   * Caller-supplied tag (typically a trackId) that lets the request
   * be cancelled via `cancelSpotifyRequestsByTag(tag)` when the
   * underlying entity disappears (track deleted from the draft
   * playlist, playlist cleared, etc.). Pending requests with this
   * tag reject with `RequestCancelledError`; in-flight requests
   * complete normally — callers must detect "entity gone" on the
   * receive side and discard the result.
   */
  tag?: string;
  /**
   * Defense-in-depth guard re-evaluated at run time (post-wait,
   * pre-send). If it returns false the request is treated as
   * cancelled — no HTTP call is made and no rate-limit slot is
   * consumed. Catches the narrow window between enqueue and the
   * explicit cancellation side-effect, plus protects against
   * deletion paths that forget to call `cancelSpotifyRequestsByTag`
   * at all.
   */
  guard?: () => boolean;
  /**
   * Scheduling priority. "high" lets a latency-sensitive request —
   * notably a user-triggered playback command — cut ahead of the
   * pending backlog of "normal" background work (search enrichment,
   * pagination) so it isn't stuck behind dozens of 334ms-spaced
   * queued requests. It does NOT bypass the rate limiter or the open
   * circuit breaker — a high-priority request still waits for the next
   * spacing slot and still fails fast during a 429 lockout. Defaults
   * to "normal".
   */
  priority?: "high" | "normal";
};

// Numeric priorities handed to the IntervalQueue. Player/playback
// commands run ahead of background search & pagination traffic.
const PRIORITY_HIGH = 1;
const PRIORITY_NORMAL = 0;

/** Bearer-authenticated request against api.spotify.com. */
export async function submitSpotifyRequest<T>(
  request: SpotifyRequest,
  clientId: string,
  options: SubmitOptions = {},
): Promise<T> {
  const response = await submitRaw(
    (signal) => sendOnce(request, clientId, signal),
    {
      path: request.path,
      tag: options.tag,
      guard: options.guard,
      priority: options.priority === "high" ? PRIORITY_HIGH : PRIORITY_NORMAL,
    },
  );
  return mapStatusToResult<T>(response, request);
}

/** Back-compat alias. New callers should prefer submitSpotifyRequest. */
export const callSpotify = submitSpotifyRequest;

/**
 * Remove every pending Spotify request tagged with `tag` from the
 * queue, rejecting their promises with `RequestCancelledError`.
 * Returns the number of requests cancelled. In-flight requests are
 * not affected.
 */
export function cancelSpotifyRequestsByTag(tag: string): number {
  return queue.cancelByTag(tag);
}

/**
 * Token-endpoint submission for accounts.spotify.com — shares the
 * same per-app quota, no Bearer header. Caller wraps `fetch()` and
 * gets the raw Response back; status-code handling is the caller's
 * responsibility (token responses have their own success/failure
 * semantics distinct from the API).
 */
export async function submitTokenRequest(
  send: () => Promise<Response>,
  path = "/api/token",
): Promise<Response> {
  // Token requests are untagged (no entity to associate with), so the
  // cancel-by-tag path never targets them. We discard the queue-
  // supplied signal here; the per-request timeout still applies via
  // the breaker + queue's normal handling. Auth-side `fetch` callers
  // retain whatever timeout discipline they bring in themselves.
  return submitRaw(() => send(), { path });
}

/** Back-compat alias used by authFlow.ts. */
export const runWithRateLimitPolicy = submitTokenRequest;

/**
 * Token-REFRESH submission for accounts.spotify.com — shares the circuit
 * breaker but deliberately BYPASSES the serial IntervalQueue.
 *
 * Why bypass the queue: a refresh is triggered from INSIDE an already-
 * in-flight API task (`sendOnce` → `getValidAccessToken`). The queue
 * runs one task at a time and awaits it to completion before starting
 * the next, so enqueueing the token POST here would deadlock — the API
 * task holds the single in-flight slot and awaits this refresh, and the
 * refresh task could never start until that API task finished. (Fires
 * ~hourly, on the first API call after the access token expires.) By not
 * enqueueing anything, the circular wait cannot form.
 *
 * What we still share: the circuit BREAKER — the load-bearing guard
 * against a 429 storm. Fully open → fail fast (don't hammer the token
 * endpoint inside a penalty window); a 429 on the refresh trips the
 * breaker so every subsequent caller (API + token) fails fast too.
 * Bursts are already impossible: `getValidAccessToken` single-flights
 * refreshes (authFlow `refreshInFlight`).
 *
 * What we deliberately do NOT do:
 *   - Take a dedicated 334ms spacing slot. The refresh is causally
 *     nested inside an API call that already paced its slot. A refresh
 *     therefore fires out-of-band, on top of the 180/min the queue may
 *     already be dispatching — so a sustained-max burst could realize a
 *     momentary 181-in-a-window peak. This is tolerated because the
 *     180/min cap is itself set below Spotify's true rolling-30s quota,
 *     so there is SLACK to absorb the occasional refresh — it is not a
 *     reserved budget (see MIN_REQUEST_SPACING_MS).
 *   - Acquire a half-open probe. The refresh is subordinate to the API
 *     request that already passed the breaker, so during half-open it
 *     must be allowed through — otherwise a probe API call that needs a
 *     token refresh could never recover the breaker (its refresh would
 *     fail-fast against the probe-in-flight guard, reopening the circuit
 *     forever while the token stays expired).
 *
 * BREAKER RECOVERY (was a load-bearing precondition): a refresh can be
 * triggered EITHER from inside an in-flight API submission (the common
 * path: sendOnce → getValidAccessToken) OR from outside one — notably the
 * Web Playback SDK's `getOAuthToken` callback, which calls
 * getValidAccessToken directly with no enclosing API request (see
 * spotifyPlayer.ts). The two cases differ only in who closes the breaker
 * after a successful half-open refresh:
 *   - Nested inside an API probe: the breaker already has a probe slot in
 *     flight (`isProbeInFlight()`), so this refresh must NOT close —
 *     closing here would reset the escalation counter out from under an
 *     enclosing probe that might still 429. The enclosing probe closes it.
 *   - Standalone (no probe in flight) during half-open: there is no
 *     enclosing probe to restore the breaker, so a successful refresh
 *     closes it ITSELF (`adoptProbe` below). Without this, a standalone
 *     refresh — e.g. the SDK token callback firing while the breaker is
 *     half-open — would succeed yet leave the breaker stuck half-open
 *     until some unrelated API call happened by to act as the probe.
 * This makes the refresh lane self-contained w.r.t. breaker recovery, so
 * it no longer depends on an enclosing API probe.
 */
export async function submitTokenRefresh(
  send: () => Promise<Response>,
  path = "/api/token",
): Promise<Response> {
  // Fully-open ban → fail fast. Half-open (remainingMs === 0, openUntil
  // in the past) falls through so recovery can proceed.
  const openMs = breaker.remainingMs();
  if (openMs > 0) {
    throw new SpotifyRateLimitError(openMs);
  }

  // Decide ONCE, synchronously at entry, whether THIS refresh owns
  // breaker recovery: it does iff the breaker is half-open AND no API
  // probe is already in flight to close it. (Nested-inside-a-probe leaves
  // probeInFlight=true → we defer to that probe; standalone half-open
  // refreshes — e.g. the SDK token callback — adopt the responsibility.)
  const adoptProbe = breaker.isHalfOpen() && !breaker.isProbeInFlight();

  const response = await send();
  if (response.status !== RATE_LIMIT_STATUS) {
    // Self-contained recovery: a standalone successful refresh that
    // traversed a half-open breaker closes it, so it can't be left stuck
    // half-open with no enclosing probe to restore it.
    //
    // Re-check isProbeInFlight() at close time (not just at entry): the
    // breaker was half-open with no probe when we decided `adoptProbe`,
    // but during our `await send()` an unrelated API call could have
    // become the half-open probe (the file's ~618-626 invariant says the
    // nested case must NOT close — closing would reset the escalation
    // counter out from under a probe that might still 429). Single-flight
    // refresh + this guard means we only close when we're still the sole
    // recovery owner; deferring to a live probe is always safe.
    if (adoptProbe && !breaker.isProbeInFlight()) breaker.close();
    return response;
  }

  // A token-endpoint 429 counts the same as an API 429: trip the shared
  // breaker, then surface the typed rate-limit error. Returning the 429
  // to refreshAccessToken would misclassify it as a fatal 4xx and
  // wrongly clear the session.
  const retryMs = readRetryAfterMs(response, path);
  breaker.trip(retryMs);
  pushRateLimitToast(breaker.remainingMs());
  throw new SpotifyRateLimitError(retryMs);
}

async function mapStatusToResult<T>(
  response: Response,
  request: SpotifyRequest,
): Promise<T> {
  if (response.status === UNAUTHORIZED_STATUS) {
    throw new SpotifyAuthExpiredError();
  }
  if (response.status === FORBIDDEN_STATUS) {
    const body = await response.text().catch(() => "");
    // Log the path/method and Spotify's (truncated) error body — enough to
    // diagnose the common User-Management 403 — but NOT the request body.
    // Dumping the raw outbound payload to the console is an unnecessary
    // data-exposure surface for a log line that's useful without it.
    console.error("Spotify 403 details", {
      path: request.path,
      method: request.method ?? "GET",
      responseBody: body.slice(0, 200),
    });
    throw new SpotifyForbiddenError(request.path, body.slice(0, 200));
  }
  if (response.status >= 500) {
    const body = await response.text().catch(() => "");
    throw new SpotifyServerError(
      request.path,
      response.status,
      body.slice(0, 200),
    );
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new SpotifyHttpError(
      request.path,
      response.status,
      text.slice(0, 200),
    );
  }
  return (await parseResponseBody<T>(response)) as T;
}

async function parseResponseBody<T>(
  response: Response,
): Promise<T | undefined> {
  if (response.status === 204) return undefined;
  if (response.headers.get("Content-Length") === "0") return undefined;
  const text = await response.text();
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new Error(
      `Spotify response was not JSON: ${
        error instanceof Error ? error.message : "parse failed"
      }`,
      { cause: error },
    );
  }
}

// --- test-only introspection ----------------------------------------------
//
// Both helpers no-op outside test mode. The functions stay exported (ESM
// can't conditionally export) so production callers calling them by
// mistake get a documented inert behavior rather than corrupting the
// shared queue / breaker state. Vitest sets `import.meta.env.MODE` to
// "test" so the test suite continues to drive them.

const IS_TEST_ENV = import.meta.env.MODE === "test";

export function __resetSpotifyRateLimitStateForTests(): void {
  if (!IS_TEST_ENV) return;
  queue.reset();
  breaker.reset();
  lastReportedRateLimitMs = 0;
  lastReportedExpiresAt = 0;
}

export function __getSpotifyRateLimitStateForTests(): {
  nextAllowedAt: number;
  pendingCount: number;
  circuitRemainingMs: number;
} {
  if (!IS_TEST_ENV) {
    return {
      nextAllowedAt: 0,
      pendingCount: 0,
      circuitRemainingMs: 0,
    };
  }
  return {
    nextAllowedAt: queue.nextRunAtTimestamp,
    pendingCount: queue.depth,
    circuitRemainingMs: breaker.remainingMs(),
  };
}
