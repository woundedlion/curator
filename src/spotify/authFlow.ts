import {
  PKCE_STATE_KEY,
  PKCE_VERIFIER_KEY,
  SPOTIFY_AUTHORIZE_URL,
  SPOTIFY_REQUEST_TIMEOUT_MS,
  SPOTIFY_SCOPES,
  SPOTIFY_TOKEN_URL,
} from "../constants";
import type { SpotifyTokens } from "../types";
import {
  SpotifyAuthExpiredError,
  SpotifyServerError,
  runWithRateLimitPolicy,
  submitTokenRefresh,
} from "./apiClient";
import {
  deriveCodeChallenge,
  generateAuthState,
  generateCodeVerifier,
} from "./pkce";
import { clearTokens, readTokens, writeTokens } from "./tokenStorage";

const ACCESS_TOKEN_REFRESH_GUARD_MS = 30 * 1000;

// Shared with apiClient's REQUEST_TIMEOUT_MS via constants. Bounded so a
// hung token-endpoint request can't trap the half-open probe slot (the
// token path shares the same breaker as api.spotify.com calls).
const TOKEN_REQUEST_TIMEOUT_MS = SPOTIFY_REQUEST_TIMEOUT_MS;

type TokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope: string;
  token_type: string;
};

// Thrown when the INITIAL authorization-code exchange returns a token
// payload with no refresh_token and no fallback. Previously this case
// silently persisted refreshToken: "" — the next refresh then POSTed an
// empty refresh_token, Spotify returned 400 (invalid_grant), and the user
// was logged out with no explanation. Failing loudly at the exchange
// boundary lets the bootstrap surface a clear "connect failed, reconnect"
// toast instead of a delayed silent logout. Typed so callers can
// discriminate it from a generic exchange failure if needed.
export class MissingRefreshTokenError extends Error {
  constructor() {
    super("Spotify token exchange returned no refresh_token");
    this.name = "MissingRefreshTokenError";
  }
}

// Thrown when the configured redirect URI is not a well-formed absolute
// http(s) URL. `spotifyRedirectUri` is user-editable free text (see
// SettingsDialog); validating at the auth boundary — rather than in the
// store — keeps the single point of truth here and lets the UI surface a
// clear error instead of bouncing the user to a malformed authorize URL
// or a token request Spotify rejects opaquely.
export class InvalidRedirectUriError extends Error {
  constructor(value: string) {
    super(`Spotify redirect URI is not a valid http(s) URL: ${value || "(empty)"}`);
    this.name = "InvalidRedirectUriError";
  }
}

// Validate at the point of use (NOT in settingsStore — that's owned
// elsewhere and stores raw free text). Rejects anything that isn't an
// absolute http: or https: URL, which is the only shape Spotify's
// authorize/token endpoints accept. Returns the normalized string.
function assertValidRedirectUri(redirectUri: string): string {
  let parsed: URL;
  try {
    parsed = new URL(redirectUri);
  } catch {
    throw new InvalidRedirectUriError(redirectUri);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new InvalidRedirectUriError(redirectUri);
  }
  return redirectUri;
}

// `requireRefresh` is set on the INITIAL code exchange (no prior token to
// fall back to). On the refresh path Spotify legitimately omits
// refresh_token to signal "reuse the existing one", so we fall back and
// never throw there.
function toTokens(
  response: TokenResponse,
  fallbackRefresh?: string,
  requireRefresh = false,
): SpotifyTokens {
  const refreshToken = response.refresh_token ?? fallbackRefresh;
  if (refreshToken === undefined || refreshToken === "") {
    if (requireRefresh) throw new MissingRefreshTokenError();
    // Refresh path with no new token and no usable fallback should not
    // happen (we always pass the existing refreshToken), but guard the
    // empty-string sentinel from ever being persisted regardless.
    throw new MissingRefreshTokenError();
  }
  return {
    accessToken: response.access_token,
    refreshToken,
    expiresAt: Date.now() + response.expires_in * 1000,
    scope: response.scope,
  };
}

function isAccessTokenFresh(tokens: SpotifyTokens): boolean {
  return tokens.expiresAt - Date.now() > ACCESS_TOKEN_REFRESH_GUARD_MS;
}

function tokenScopes(tokens: SpotifyTokens): Set<string> {
  return new Set(tokens.scope.split(/\s+/).filter(Boolean));
}

const REQUIRED_SCOPES = SPOTIFY_SCOPES.split(/\s+/).filter(Boolean);

// Returns scopes the cached token is missing relative to the current
// SPOTIFY_SCOPES list. Users who authorized before a scope was added
// will keep getting 403s on the new endpoint until they reconnect; this
// lets the bootstrap detect that proactively instead of waiting for a
// confusing 403 on first publish.
export function missingScopes(tokens: SpotifyTokens): string[] {
  const granted = tokenScopes(tokens);
  return REQUIRED_SCOPES.filter((scope) => !granted.has(scope));
}

export function readTokensIfScopesValid(): SpotifyTokens | null {
  const tokens = readTokens();
  if (!tokens) return null;
  if (missingScopes(tokens).length > 0) return null;
  return tokens;
}

export async function beginAuthFlow(
  clientId: string,
  redirectUri: string,
): Promise<void> {
  // Validate the user-editable redirect URI before it flows into the
  // authorize URL (and later the token request). A malformed value here
  // produces a confusing dead-end on Spotify's side; throw a typed error
  // the UI can surface instead.
  assertValidRedirectUri(redirectUri);
  const verifier = generateCodeVerifier();
  const challenge = await deriveCodeChallenge(verifier);
  const state = generateAuthState();
  sessionStorage.setItem(PKCE_VERIFIER_KEY, verifier);
  sessionStorage.setItem(PKCE_STATE_KEY, state);

  const params = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: redirectUri,
    code_challenge_method: "S256",
    code_challenge: challenge,
    state,
    scope: SPOTIFY_SCOPES,
  });
  window.location.assign(`${SPOTIFY_AUTHORIZE_URL}?${params.toString()}`);
}

// Token endpoints live on accounts.spotify.com, not api.spotify.com, so they
// can't go through callSpotify (no Bearer, different base). But they DO count
// against the same per-IP rate budget, and Spotify enforces it with the same
// 429 + Retry-After contract — so they share the same circuit breaker. This
// stops a 429 storm from triggering an unguarded burst of refresh attempts
// that would deepen the lockout.
//
// `submit` selects the rate-limit lane. The default (the FIFO-backed
// runWithRateLimitPolicy) is used by the one-time OAuth code exchange, which
// is never re-entrant. The refresh path passes `submitTokenRefresh`, which
// shares the breaker but skips the serial queue — a refresh is triggered from
// inside an in-flight API task, and re-entering the single-slot queue would
// deadlock (see submitTokenRefresh).
function postToTokenEndpoint(
  body: URLSearchParams,
  submit: typeof runWithRateLimitPolicy = runWithRateLimitPolicy,
): Promise<Response> {
  return submit(
    () => {
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(),
        TOKEN_REQUEST_TIMEOUT_MS,
      );
      return fetch(SPOTIFY_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
        // Defense-in-depth: never let a token response touch the HTTP
        // cache. Auth material must not be served from / written to cache.
        cache: "no-store",
        signal: controller.signal,
      }).finally(() => clearTimeout(timer));
    },
    "/api/token",
  );
}

async function exchangeAuthorizationCode(
  clientId: string,
  redirectUri: string,
  code: string,
  verifier: string,
): Promise<SpotifyTokens> {
  // Validate again at the token-request boundary — completeAuthFlow can
  // be reached on the redirect-back path without having gone through this
  // process's beginAuthFlow (e.g. a stored callback after reload), so the
  // earlier check isn't guaranteed to have run.
  assertValidRedirectUri(redirectUri);
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: verifier,
  });
  const response = await postToTokenEndpoint(body);
  if (!response.ok) throw new Error("Spotify token exchange failed");
  const json = (await response.json()) as TokenResponse;
  // requireRefresh: the initial exchange MUST yield a refresh_token. If
  // Spotify returns none, throw rather than persisting an empty-string
  // sentinel that would 400 on the next refresh and silently log the user
  // out.
  return toTokens(json, undefined, true);
}

export type CallbackParams = {
  code: string;
  state: string;
};

export type AuthCallback =
  | { kind: "code"; code: string; state: string }
  | { kind: "error"; error: string; description?: string };

// readCallbackParams returns just the success-shaped payload (kept for
// API compatibility with code that only cares about the happy path).
// readAuthCallback returns the discriminated union including denials
// (?error=access_denied) so callers can show a clear toast instead of
// silently falling through to "disconnected" with no explanation.
export function readCallbackParams(): CallbackParams | null {
  const url = new URL(window.location.href);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) return null;
  return { code, state };
}

export function readAuthCallback(): AuthCallback | null {
  const url = new URL(window.location.href);
  const error = url.searchParams.get("error");
  if (error) {
    const description =
      url.searchParams.get("error_description") ?? undefined;
    return { kind: "error", error, description };
  }
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) return null;
  return { kind: "code", code, state };
}

export function clearCallbackParams(): void {
  const url = new URL(window.location.href);
  url.searchParams.delete("code");
  url.searchParams.delete("state");
  url.searchParams.delete("error");
  // OAuth denials also carry error_description/error_uri; strip them too
  // so a rejection doesn't leave provider error text lingering in the
  // address bar and browser history after we've handled it.
  url.searchParams.delete("error_description");
  url.searchParams.delete("error_uri");
  window.history.replaceState({}, "", url.toString());
}

function clearPkceKeys(): void {
  sessionStorage.removeItem(PKCE_STATE_KEY);
  sessionStorage.removeItem(PKCE_VERIFIER_KEY);
}

export async function completeAuthFlow(
  clientId: string,
  redirectUri: string,
  callback: CallbackParams,
): Promise<SpotifyTokens> {
  const expectedState = sessionStorage.getItem(PKCE_STATE_KEY);
  const verifier = sessionStorage.getItem(PKCE_VERIFIER_KEY);
  if (!expectedState || !verifier) {
    clearPkceKeys();
    throw new Error("Missing PKCE state");
  }
  if (expectedState !== callback.state) {
    // CSRF defense: a state mismatch may indicate a forged callback. Drop
    // both keys so a follow-up legitimate flow starts fresh, and never
    // reuse a verifier that was bound to a now-suspect state.
    clearPkceKeys();
    throw new Error("PKCE state mismatch");
  }

  try {
    const tokens = await exchangeAuthorizationCode(
      clientId,
      redirectUri,
      callback.code,
      verifier,
    );
    clearPkceKeys();
    writeTokens(tokens);
    return tokens;
  } catch (error) {
    // Verifier is consumed by the failed exchange — Spotify won't accept
    // it again. Clearing here prevents a stale-verifier replay on the
    // next attempt.
    clearPkceKeys();
    throw error;
  }
}

async function refreshAccessToken(
  clientId: string,
  tokens: SpotifyTokens,
): Promise<SpotifyTokens> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: tokens.refreshToken,
    client_id: clientId,
  });
  // Refresh lane: shares the breaker but bypasses the serial queue, so a
  // refresh triggered from inside an in-flight API task can't deadlock.
  const response = await postToTokenEndpoint(body, submitTokenRefresh);
  if (!response.ok) {
    // Distinguish unrecoverable session loss (400/401 — invalid_grant or
    // unauthorized client) from a transient Spotify outage (5xx). Clearing
    // tokens on a 502 would log the user out for every flake; let the
    // caller retry instead.
    if (response.status >= 500) {
      // Typed (not a bare Error) so callers can discriminate. In
      // particular the playlist push treats a token-endpoint server
      // error as fatal — there's no point retrying the same doomed
      // refresh once per remaining chunk — while keeping chunk-level
      // 5xx on the /items call itself retryable.
      throw new SpotifyServerError(
        "/api/token",
        response.status,
        "token refresh transient failure",
      );
    }
    clearTokens();
    // Refresh failure means the session is irrecoverably gone — surface a
    // typed error so callers (e.g. spotifyStore.loadPlaylists) flip
    // `connected: false` and toast "reconnect in Settings".
    throw new SpotifyAuthExpiredError();
  }
  const json = (await response.json()) as TokenResponse;
  const refreshed = toTokens(json, tokens.refreshToken);
  // Re-validate the refreshed token's scopes (mirrors
  // readTokensIfScopesValid for the cached-token path). Spotify can mint a
  // refreshed token with a narrower scope set than originally granted — if
  // a required scope is now missing, the session is effectively unusable
  // for our endpoints, so treat it like the initial missing-scope case:
  // clear tokens and surface the typed auth error prompting a reconnect.
  // Persisting it would just defer the failure to a confusing 403 later.
  if (missingScopes(refreshed).length > 0) {
    clearTokens();
    throw new SpotifyAuthExpiredError();
  }
  writeTokens(refreshed);
  return refreshed;
}

// Serializes concurrent refresh attempts. Without this, N near-simultaneous
// Spotify calls all see the same expiring token and each fire a refresh —
// Spotify invalidates earlier refresh tokens on use, so racing refreshes
// log the user out unpredictably. Keyed on clientId so a refresh for one
// app can never hand back a token minted for a different one (clientId is
// stable per session in practice, but the bare boolean conflated "one
// refresh" with "one client").
let refreshInFlight:
  | { clientId: string; promise: Promise<SpotifyTokens>; token: object }
  | null = null;

export async function getValidAccessToken(clientId: string): Promise<string> {
  const tokens = readTokens();
  if (!tokens) throw new SpotifyAuthExpiredError();
  if (isAccessTokenFresh(tokens)) return tokens.accessToken;
  if (!refreshInFlight || refreshInFlight.clientId !== clientId) {
    // `token` is a unique identity for this in-flight entry. The stored
    // (and awaited) promise IS the finally-chained one, so a refresh
    // rejection has exactly one consumer path — the awaiter below — and
    // never surfaces as an unhandled rejection. The finally clears only
    // our own entry on settle (matched by token), since a newer clientId
    // may have already replaced us.
    const token = {};
    const promise = refreshAccessToken(clientId, tokens).finally(() => {
      if (refreshInFlight?.token === token) refreshInFlight = null;
    });
    refreshInFlight = { clientId, promise, token };
  }
  const refreshed = await refreshInFlight.promise;
  return refreshed.accessToken;
}

export function disconnectFromSpotify(): void {
  clearTokens();
  sessionStorage.removeItem(PKCE_STATE_KEY);
  sessionStorage.removeItem(PKCE_VERIFIER_KEY);
}
