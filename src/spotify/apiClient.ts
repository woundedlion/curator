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
// minutes idle, the next 4 calls still go out 350 ms apart. This is
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
//     hidden this way). The default fallback is 5 minutes — short
//     enough not to strand on a benign 429, long enough to break the
//     retry-into-ban loop on a hidden multi-hour penalty.
//   - Queue and breaker state are both persisted to localStorage; a
//     page reload after a heavy burst doesn't reset the spacing
//     Spotify is still counting against the rolling window, and it
//     can't reset an active ban.

import { getValidAccessToken } from "./authFlow";
import { CircuitBreaker } from "./circuitBreaker";
import { IntervalQueue, type QueueDepthObserver } from "../util/intervalQueue";
import {
  SPOTIFY_API_BASE,
  SPOTIFY_NEXT_ALLOWED_AT_KEY,
} from "../constants";

export { RequestCancelledError } from "../util/intervalQueue";

// --- tuning constants ------------------------------------------------------

const RATE_LIMIT_STATUS = 429;
const UNAUTHORIZED_STATUS = 401;
const FORBIDDEN_STATUS = 403;

// Spotify's per-app per-IP quota varies. 350ms caps sustained rate at
// ~2.85 req/sec, leaving headroom for SDK / token refresh / sidebar
// noise that share the quota. Bumping this is the safest knob if you
// see 429s in steady-state usage.
const MIN_REQUEST_SPACING_MS = 350;

// Cap a corrupt/stale persisted spacing timestamp so a bad
// localStorage value can't deadlock the bucket.
const NEXT_ALLOWED_AT_CAP_MS = 60_000;

// Circuit-open bounds. Min is so a "1s" Retry-After doesn't leave us
// essentially open (the half-open probe semantics need real time to
// drain Spotify's window). Max bounds a hostile response.
const CIRCUIT_BREAKER_MIN_MS = 5_000;
const CIRCUIT_BREAKER_MAX_MS = 60 * 60 * 1000;

// Pessimistic Retry-After fallback. See `parseRetryAfter`.
const DEFAULT_RETRY_AFTER_SECONDS = 5 * 60;
const MAX_RETRY_AFTER_MS = 60 * 60 * 1000;

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

export class SpotifyNetworkError extends Error {
  constructor(cause: unknown) {
    const detail =
      cause instanceof Error ? cause.message : String(cause ?? "unknown");
    super(`Spotify network error: ${detail}`);
    this.name = "SpotifyNetworkError";
  }
}

// --- Retry-After parsing ---------------------------------------------------

export function parseRetryAfter(
  headerValue: string | null,
  nowMs: number = Date.now(),
): number {
  // RFC 9110 §10.2.3: integer delta-seconds OR HTTP-date.
  if (headerValue) {
    const trimmed = headerValue.trim();
    if (/^\d+$/.test(trimmed)) {
      const seconds = parseInt(trimmed, 10);
      return clampRetryAfterMs(Math.max(1, seconds) * 1000);
    }
    const dateMs = Date.parse(trimmed);
    if (Number.isFinite(dateMs)) {
      return clampRetryAfterMs(Math.max(1000, dateMs - nowMs));
    }
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

let lastReportedRateLimitMs = 0;

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
  if (retryMs <= lastReportedRateLimitMs) return;
  lastReportedRateLimitMs = retryMs;
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
  setTimeout(() => {
    if (lastReportedRateLimitMs === retryMs) lastReportedRateLimitMs = 0;
  }, retryMs + 1000);
}

// --- request submission ----------------------------------------------------

export type SpotifyRequest = {
  path: string;
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: unknown;
  query?: Record<string, string | number | undefined>;
};

function appendQuery(path: string, query?: SpotifyRequest["query"]): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value));
  }
  const queryString = params.toString();
  return queryString ? `${path}?${queryString}` : path;
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
): Promise<Response> {
  const accessToken = await getValidAccessToken(clientId);
  const url = `${SPOTIFY_API_BASE}${appendQuery(request.path, request.query)}`;
  const hasBody = request.body !== undefined;
  try {
    return await fetch(url, {
      method: request.method ?? "GET",
      headers: buildHeaders(accessToken, hasBody),
      body: hasBody ? JSON.stringify(request.body) : undefined,
    });
  } catch (cause) {
    throw new SpotifyNetworkError(cause);
  }
}

/**
 * Core submission — wires the queue and breaker around a raw send.
 * NO in-call retries. A 429 trips the breaker and propagates as
 * SpotifyRateLimitError; subsequent callers fail fast until the
 * window expires and the next caller becomes the half-open probe.
 */
async function submitRaw(
  send: () => Promise<Response>,
  context: { path: string; tag?: string; guard?: () => boolean },
): Promise<Response> {
  // Breaker check is synchronous and happens BEFORE enqueueing — a
  // fail-fast caller shouldn't take a queue slot, and a probe must
  // be the one that runs first when the breaker is half-open.
  const slot = breaker.tryAcquire();
  if (slot === "fail-fast") {
    throw new SpotifyRateLimitError(breaker.remainingMs());
  }
  const isProbe = slot === "probe";

  return queue.enqueue(async () => {
    try {
      // Another caller may have tripped the breaker while we were
      // queued; non-probe callers respect the new window.
      if (!isProbe && breaker.remainingMs() > 0) {
        throw new SpotifyRateLimitError(breaker.remainingMs());
      }

      const response = await send();
      if (response.status !== RATE_LIMIT_STATUS) {
        if (isProbe) breaker.close();
        return response;
      }

      const retryMs = readRetryAfterMs(response, context.path);
      pushRateLimitToast(retryMs);
      breaker.trip(retryMs);
      // No `queue.recordExternalPause` here. The breaker is the
      // authoritative cool-off — every queued/future caller checks
      // it and fails fast. If we also pushed the queue's next-run-at
      // forward by retryMs, pending tasks would sit in the queue for
      // the entire ban window before they could even reach the
      // breaker check, masking the fail-fast as a timeout.
      throw new SpotifyRateLimitError(retryMs);
    } finally {
      if (isProbe) breaker.releaseProbe();
    }
  }, { tag: context.tag, guard: context.guard });
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
};

/** Bearer-authenticated request against api.spotify.com. */
export async function submitSpotifyRequest<T>(
  request: SpotifyRequest,
  clientId: string,
  options: SubmitOptions = {},
): Promise<T> {
  const response = await submitRaw(() => sendOnce(request, clientId), {
    path: request.path,
    tag: options.tag,
    guard: options.guard,
  });
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
  return submitRaw(send, { path });
}

/** Back-compat alias used by authFlow.ts. */
export const runWithRateLimitPolicy = submitTokenRequest;

async function mapStatusToResult<T>(
  response: Response,
  request: SpotifyRequest,
): Promise<T> {
  if (response.status === UNAUTHORIZED_STATUS) {
    throw new SpotifyAuthExpiredError();
  }
  if (response.status === FORBIDDEN_STATUS) {
    const body = await response.text().catch(() => "");
    console.error("Spotify 403 details", {
      path: request.path,
      method: request.method ?? "GET",
      requestBody: request.body,
      responseBody: body,
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
    throw new Error(`Spotify ${response.status}: ${text}`);
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

export function __resetSpotifyRateLimitStateForTests(): void {
  queue.reset();
  breaker.reset();
  lastReportedRateLimitMs = 0;
}

export function __getSpotifyRateLimitStateForTests(): {
  nextAllowedAt: number;
  circuitOpenUntil: number;
  pendingCount: number;
  circuitRemainingMs: number;
} {
  return {
    nextAllowedAt: queue.nextRunAtTimestamp,
    circuitOpenUntil: 0, // exposed via circuitRemainingMs for assertions
    pendingCount: queue.depth,
    circuitRemainingMs: breaker.remainingMs(),
  };
}
