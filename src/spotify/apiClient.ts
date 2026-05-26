import { SPOTIFY_API_BASE } from "../constants";
import { getValidAccessToken } from "./authFlow";

const RATE_LIMIT_STATUS = 429;
const UNAUTHORIZED_STATUS = 401;
const FORBIDDEN_STATUS = 403;
const DEFAULT_RETRY_AFTER_SECONDS = 1;
const MAX_RETRY_ATTEMPTS = 3;
const BACKOFF_JITTER_MS = 300;

// Once we throw SpotifyRateLimitError, the circuit is "open" for this long.
// During that window every callSpotify fails fast with the same error so we
// stop hammering and let the penalty window drain. After it elapses the
// circuit auto-closes and normal traffic resumes.
const CIRCUIT_BREAKER_DURATION_MS = 30_000;
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

function readRetryAfterMs(response: Response): number {
  const header = response.headers.get("Retry-After");
  const parsed = header ? parseInt(header, 10) : NaN;
  const seconds = Number.isFinite(parsed) ? parsed : DEFAULT_RETRY_AFTER_SECONDS;
  return Math.max(1, seconds) * 1000;
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
// share this so a 429 from any of them pauses everyone, preventing the
// herd-of-retries pattern.
let nextAllowedAt = 0;

// Once tripped, all subsequent callSpotify invocations fail fast until
// circuitOpenUntil passes. Tripped when MAX_RETRY_ATTEMPTS is reached.
let circuitOpenUntil = 0;
let rateLimitToastShown = false;

function pushRateLimitToastOnce(retryMs: number): void {
  if (rateLimitToastShown) return;
  rateLimitToastShown = true;
  void import("../store/uiStore").then(({ useUiStore }) => {
    useUiStore.getState().pushToast({
      kind: "error",
      message: `Spotify rate-limited — pausing all requests for ${Math.ceil(retryMs / 1000)}s`,
    });
    setTimeout(() => {
      rateLimitToastShown = false;
    }, retryMs + 1000);
  });
}

async function waitForRateLimitWindow(): Promise<void> {
  const now = Date.now();
  if (now < nextAllowedAt) {
    await sleep(nextAllowedAt - now);
  }
}

function recordRateLimit(retryMs: number): void {
  const target = Date.now() + retryMs;
  if (target > nextAllowedAt) nextAllowedAt = target;
}

function openCircuit(retryMs: number): void {
  const cooloff = Math.max(retryMs, CIRCUIT_BREAKER_MIN_MS);
  circuitOpenUntil = Date.now() + Math.min(cooloff, CIRCUIT_BREAKER_DURATION_MS);
}

function circuitRemainingMs(): number {
  return Math.max(0, circuitOpenUntil - Date.now());
}

export function resetSpotifyCircuit(): void {
  circuitOpenUntil = 0;
  nextAllowedAt = 0;
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
  return fetch(url, {
    method: request.method ?? "GET",
    headers: buildHeaders(accessToken, hasBody),
    body: hasBody ? JSON.stringify(request.body) : undefined,
  });
}

function failFastIfCircuitOpen(): void {
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
  failFastIfCircuitOpen();
  let attempt = 0;
  while (true) {
    await waitForRateLimitWindow();
    // Re-check the breaker after sleeping. Another caller may have tripped
    // it while we were waiting in the rate-limit window; without this
    // check the "stop digging" semantic leaks (DESIGN §4.5 ¶3).
    failFastIfCircuitOpen();
    const response = await send();
    if (response.status !== RATE_LIMIT_STATUS) return response;

    attempt++;
    const retryMs = honorRetryAfterWithJitter(readRetryAfterMs(response));
    recordRateLimit(retryMs);
    pushRateLimitToastOnce(retryMs);
    if (attempt >= MAX_RETRY_ATTEMPTS) {
      openCircuit(retryMs);
      throw new SpotifyRateLimitError(retryMs);
    }
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
    throw new SpotifyForbiddenError(request.path, body.slice(0, 200));
  }
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Spotify ${response.status}: ${text}`);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}
