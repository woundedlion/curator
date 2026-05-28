import {
  PKCE_STATE_KEY,
  PKCE_VERIFIER_KEY,
  SPOTIFY_AUTHORIZE_URL,
  SPOTIFY_SCOPES,
  SPOTIFY_TOKEN_URL,
} from "../constants";
import type { SpotifyTokens } from "../types";
import { SpotifyAuthExpiredError, runWithRateLimitPolicy } from "./apiClient";
import {
  deriveCodeChallenge,
  generateAuthState,
  generateCodeVerifier,
} from "./pkce";
import { clearTokens, readTokens, writeTokens } from "./tokenStorage";

const ACCESS_TOKEN_REFRESH_GUARD_MS = 30 * 1000;

type TokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope: string;
  token_type: string;
};

function toTokens(response: TokenResponse, fallbackRefresh?: string): SpotifyTokens {
  const refreshToken = response.refresh_token ?? fallbackRefresh ?? "";
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
// 429 + Retry-After contract — so we share the wrapper's wait window and
// circuit breaker. This stops a 429 storm from triggering an unguarded burst
// of refresh attempts that would deepen the lockout.
function postToTokenEndpoint(body: URLSearchParams): Promise<Response> {
  return runWithRateLimitPolicy(
    () =>
      fetch(SPOTIFY_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      }),
    "/api/token",
  );
}

async function exchangeAuthorizationCode(
  clientId: string,
  redirectUri: string,
  code: string,
  verifier: string,
): Promise<SpotifyTokens> {
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
  return toTokens(json);
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
  const response = await postToTokenEndpoint(body);
  if (!response.ok) {
    // Distinguish unrecoverable session loss (400/401 — invalid_grant or
    // unauthorized client) from a transient Spotify outage (5xx). Clearing
    // tokens on a 502 would log the user out for every flake; let the
    // caller retry instead.
    if (response.status >= 500) {
      throw new Error(`Spotify token refresh transient failure: ${response.status}`);
    }
    clearTokens();
    // Refresh failure means the session is irrecoverably gone — surface a
    // typed error so callers (e.g. spotifyStore.loadPlaylists) flip
    // `connected: false` and toast "reconnect in Settings".
    throw new SpotifyAuthExpiredError();
  }
  const json = (await response.json()) as TokenResponse;
  const refreshed = toTokens(json, tokens.refreshToken);
  writeTokens(refreshed);
  return refreshed;
}

// Serializes concurrent refresh attempts. Without this, N near-simultaneous
// Spotify calls all see the same expiring token and each fire a refresh —
// Spotify invalidates earlier refresh tokens on use, so racing refreshes
// log the user out unpredictably.
let refreshInFlight: Promise<SpotifyTokens> | null = null;

export async function getValidAccessToken(clientId: string): Promise<string> {
  const tokens = readTokens();
  if (!tokens) throw new SpotifyAuthExpiredError();
  if (isAccessTokenFresh(tokens)) return tokens.accessToken;
  if (!refreshInFlight) {
    refreshInFlight = refreshAccessToken(clientId, tokens).finally(() => {
      refreshInFlight = null;
    });
  }
  const refreshed = await refreshInFlight;
  return refreshed.accessToken;
}

export function disconnectFromSpotify(): void {
  clearTokens();
  sessionStorage.removeItem(PKCE_STATE_KEY);
  sessionStorage.removeItem(PKCE_VERIFIER_KEY);
}
