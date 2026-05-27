import {
  SPOTIFY_API_BASE,
  SPOTIFY_CIRCUIT_OPEN_UNTIL_KEY,
} from "../constants";
import { getValidAccessToken } from "./authFlow";

function readPersistedCircuitOpenUntil(): number {
  try {
    const raw = localStorage.getItem(SPOTIFY_CIRCUIT_OPEN_UNTIL_KEY);
    if (!raw) return 0;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed <= Date.now()) return 0;
    return parsed;
  } catch {
    // localStorage can throw in private mode / quota-exceeded — treat
    // as no persisted state and continue.
    return 0;
  }
}

function persistCircuitOpenUntil(timestamp: number): void {
  try {
    if (timestamp <= Date.now()) {
      localStorage.removeItem(SPOTIFY_CIRCUIT_OPEN_UNTIL_KEY);
    } else {
      localStorage.setItem(SPOTIFY_CIRCUIT_OPEN_UNTIL_KEY, String(timestamp));
    }
  } catch {
    // ignore — persistence is best-effort
  }
}

const RATE_LIMIT_STATUS = 429;
const UNAUTHORIZED_STATUS = 401;
const FORBIDDEN_STATUS = 403;
// Spotify generally omits Retry-After on the very first 429 of a window;
// when we can't read a real number we pessimistically assume 30 seconds.
// (Spotify's documented rate-limit window is rolling-30s — anything less
// means we just hit the wall again and earn a bigger penalty.)
const DEFAULT_RETRY_AFTER_SECONDS = 30;
const MAX_RETRY_ATTEMPTS = 3;
const BACKOFF_JITTER_MS = 300;

// Proactive per-request spacing. Spotify's informal limit is roughly
// 180 requests per rolling 30s window (~6 req/sec) shared across the
// whole app. The concurrency limiter (4 in flight) alone would burst at
// ~20 req/sec for fast endpoints — enough to burn the quota in seconds
// and earn multi-hour Retry-After penalties. Spacing every request at
// least 250ms apart caps the sustained rate at ~4 req/sec, leaving
// headroom for unrelated calls (player, /me, playlist read) without
// tripping the limit.
const MIN_REQUEST_SPACING_MS = 250;

// When we hit the retry cap we open the circuit for the FULL Retry-After
// window so subsequent calls fail fast instead of hammering. The cap
// here is the maximum amount of time we'll keep the circuit open
// without manual reset — high enough to honor real Spotify penalties
// (which can be 10+ minutes), low enough that a forgotten tab isn't
// permanently broken.
const CIRCUIT_BREAKER_MAX_MS = 60 * 60 * 1000;
const CIRCUIT_BREAKER_MIN_MS = 5_000;

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

// Upper bound on a respected Retry-After. We honor up to 1 hour — long
// enough to wait out real Spotify penalties (the quota-exhausted case
// returns multi-hour values), short enough that a stuck wait window
// self-heals if Spotify or our parser ever returns garbage.
const MAX_RETRY_AFTER_MS = 60 * 60 * 1000;

export function parseRetryAfter(
  headerValue: string | null,
  nowMs: number = Date.now(),
): number {
  // RFC 9110 §10.2.3: Retry-After is either delta-seconds (a non-negative
  // integer) or an HTTP-date. Try integer first (Spotify always uses
  // this form), then HTTP-date as a fallback for other origins.
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
    // Header was present but unparseable — log loudly because the default
    // fallback (30s) is way too short if Spotify actually wanted hours.
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

function readRetryAfterMs(response: Response): number {
  const raw = response.headers.get("Retry-After");
  const parsed = parseRetryAfter(raw);
  // Always log the raw header so a future incident can be diagnosed
  // from the console without re-instrumenting.
  console.warn("Spotify 429", {
    rawRetryAfter: raw,
    parsedWaitMs: parsed,
  });
  return parsed;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

// Per-call concurrent wait window — all in-flight callSpotify invocations
// share this so a 429 from any of them pauses everyone, AND every
// request bumps it forward by MIN_REQUEST_SPACING_MS so we proactively
// cap our outgoing rate even when Spotify is replying happily.
let nextAllowedAt = 0;

// Classic three-state circuit breaker:
//   - closed       (circuitOpenUntil === 0)        — traffic flows normally
//   - open         (now < circuitOpenUntil)        — everything fails fast
//   - half-open    (now >= circuitOpenUntil > 0)   — exactly ONE probe
//                                                    request is allowed
//                                                    through to verify the
//                                                    penalty has lifted;
//                                                    everyone else still
//                                                    fails fast until the
//                                                    probe settles
// Without the half-open phase, a queue of N concurrent calls all flood
// through the moment the timer elapses; if Spotify still wants us to wait,
// every one of them earns a fresh 429 and we end up with a bigger penalty.
//
// `circuitOpenUntil` is persisted to localStorage. Spotify enforces the
// rate-limit penalty per app (client_id), not per tab — a fresh page
// load that ignores the in-flight penalty would immediately re-burn the
// quota.
let circuitOpenUntil = readPersistedCircuitOpenUntil();
let probeInFlight = false;
// Most recent rate-limit penalty seen, in ms. Used to display the
// largest-known wait time when multiple 429s overlap — the previous
// "show the first toast and suppress later ones" logic could leave the
// user staring at "2s" when the actual penalty turned out to be hours.
let lastReportedRateLimitMs = 0;

function pushRateLimitToast(retryMs: number): void {
  // Only escalate the toast — never downgrade it. If a 429 with a tiny
  // Retry-After arrived first and a much larger one arrives after, the
  // user needs to see the bigger number, not the misleading first one.
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
  // Reset the high-water mark after the penalty elapses so a later
  // (unrelated) rate-limit incident can re-toast.
  setTimeout(() => {
    if (lastReportedRateLimitMs === retryMs) lastReportedRateLimitMs = 0;
  }, retryMs + 1000);
}

// Wait for the shared rate-limit window to elapse, THEN reserve the
// next outgoing slot synchronously. The reservation happens in the same
// microtask as the loop exit (after the last `await`), so two callers
// that both wake from sleep at the same time serialize cleanly — the
// first one bumps nextAllowedAt, the second sees the new value and
// loops back to sleep again.
async function waitForRateLimitAndReserveSlot(): Promise<void> {
  while (Date.now() < nextAllowedAt) {
    await sleep(nextAllowedAt - Date.now());
  }
  nextAllowedAt = Date.now() + MIN_REQUEST_SPACING_MS;
}

function recordRateLimit(retryMs: number): void {
  // A 429-driven pause should be at LEAST the proactive spacing — but
  // typically much longer. Compare and take the larger.
  const target = Date.now() + retryMs;
  if (target > nextAllowedAt) nextAllowedAt = target;
}

function openCircuit(retryMs: number): void {
  // Open the circuit for the full Retry-After window (up to 1 hour).
  // The old 30-second cap meant we'd close the circuit, retry, get
  // 429'd again, open the circuit, repeat — racking up bigger penalties
  // each loop. Honoring the real wait window lets the user wait it
  // out exactly once.
  const cooloff = Math.max(retryMs, CIRCUIT_BREAKER_MIN_MS);
  circuitOpenUntil = Date.now() + Math.min(cooloff, CIRCUIT_BREAKER_MAX_MS);
  persistCircuitOpenUntil(circuitOpenUntil);
}

function closeCircuit(): void {
  circuitOpenUntil = 0;
  persistCircuitOpenUntil(0);
  lastReportedRateLimitMs = 0;
}

// Caller's role with respect to the breaker. The first call after the
// open window elapses becomes the probe; everyone else fails fast until
// the probe reports back.
type CircuitSlot = "pass" | "probe" | "fail-fast";

function tryAcquireCircuitSlot(): CircuitSlot {
  const now = Date.now();
  if (circuitOpenUntil === 0) return "pass";
  if (now < circuitOpenUntil) return "fail-fast";
  // Window elapsed — we're in half-open territory.
  if (probeInFlight) return "fail-fast";
  probeInFlight = true;
  return "probe";
}

function releaseProbe(): void {
  probeInFlight = false;
}

function circuitRemainingMs(): number {
  return Math.max(0, circuitOpenUntil - Date.now());
}

export function resetSpotifyCircuit(): void {
  // Only clear the breaker — leave `nextAllowedAt` to expire naturally.
  // Wiping the wait window means the next call burst-fires before the
  // server-asked cool-off ended, which often re-trips immediately.
  closeCircuit();
  probeInFlight = false;
}

export function spotifyCircuitOpenMs(): number {
  return circuitRemainingMs();
}

function honorRetryAfterWithJitter(retryAfterMs: number): number {
  // Spotify's Retry-After is authoritative — it knows when its bucket will
  // refill. Don't multiply (no exponential ramp-up); just honor it and add a
  // small jitter so concurrent requests don't all retry at the exact same
  // millisecond.
  return retryAfterMs + Math.random() * BACKOFF_JITTER_MS;
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
    // fetch() rejects on network errors, DNS failures, CORS preflight
    // rejections, AbortError, etc. Bubble these as typed so callers can
    // distinguish "Spotify is unreachable" from "Spotify rejected us."
    throw new SpotifyNetworkError(cause);
  }
}

function failFastForNonProbe(isProbe: boolean): void {
  if (isProbe) return;
  const remaining = circuitRemainingMs();
  if (remaining > 0) throw new SpotifyRateLimitError(remaining);
}

// Drives the shared rate-limit window, 429 retry loop, and circuit breaker
// around an arbitrary HTTP send. Use this for any Spotify-host request that
// can't go through callSpotify directly (e.g. token endpoints, which have a
// different base URL and no Bearer header). Returns the final Response —
// callers handle status codes other than 429.
export async function runWithRateLimitPolicy(
  send: () => Promise<Response>,
): Promise<Response> {
  const slot = tryAcquireCircuitSlot();
  if (slot === "fail-fast") {
    throw new SpotifyRateLimitError(circuitRemainingMs());
  }
  const isProbe = slot === "probe";

  let attempt = 0;
  try {
    while (true) {
      await waitForRateLimitAndReserveSlot();
      // Re-check the breaker after sleeping. Another caller may have
      // tripped it while we were waiting; non-probe callers respect the
      // new window and fail fast. The probe always proceeds — it has
      // exclusive permission until it settles.
      failFastForNonProbe(isProbe);

      const response = await send();
      if (response.status !== RATE_LIMIT_STATUS) {
        // First success after a circuit opening — fully close.
        if (isProbe) closeCircuit();
        return response;
      }

      attempt++;
      const retryMs = honorRetryAfterWithJitter(readRetryAfterMs(response));
      recordRateLimit(retryMs);
      pushRateLimitToast(retryMs);
      // The probe is a single-shot verification. If Spotify still wants
      // us to wait, don't retry inside the probe — open the circuit for
      // the new window and let the next probe try after it elapses.
      // Normal calls keep their retry budget so transient 429s
      // (Spotify's bucket refilling mid-second) self-heal.
      if (isProbe || attempt >= MAX_RETRY_ATTEMPTS) {
        openCircuit(retryMs);
        throw new SpotifyRateLimitError(retryMs);
      }
    }
  } finally {
    if (isProbe) releaseProbe();
  }
}

export async function callSpotify<T>(
  request: SpotifyRequest,
  clientId: string,
): Promise<T> {
  const response = await runWithRateLimitPolicy(() =>
    sendOnce(request, clientId),
  );

  if (response.status === UNAUTHORIZED_STATUS) {
    throw new SpotifyAuthExpiredError();
  }
  if (response.status === FORBIDDEN_STATUS) {
    const body = await response.text().catch(() => "");
    // Log full diagnostic details to the console so users hitting a 403
    // can either share them for debugging or correlate with their
    // Spotify Dashboard. The stock Spotify 403 body is just "Forbidden"
    // — the request method + body, plus any specifics in `body`, are
    // what disambiguates "missing scope" vs "user not allowlisted" vs
    // "invalid combination."
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

async function parseResponseBody<T>(response: Response): Promise<T | undefined> {
  // Successful responses with no body — 204 No Content, and 200/201
  // responses with Content-Length: 0 (which Spotify returns from some
  // player endpoints) — would throw SyntaxError from response.json().
  // Treat both as undefined-bodied success.
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
    );
  }
}
