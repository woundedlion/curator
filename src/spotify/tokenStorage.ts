import { TOKENS_STORAGE_KEY } from "../constants";
import type { SpotifyTokens } from "../types";

// sessionStorage can throw on every operation in two known scenarios:
//   - QuotaExceededError when the partition is full (rare; tokens are
//     small).
//   - SecurityError when the host is in a third-party-cookies-blocked
//     iframe context, or in some private-browsing modes where storage
//     is gated.
// Both surfaces want to be tolerated, not crashed on — a refresh-token
// path that throws an uncategorized error during a 429 storm would
// otherwise propagate as a `SpotifyAuthExpiredError`-adjacent failure
// and force the user to manually reconnect for an unrelated reason.

// sessionStorage is user-writable (devtools) and can carry a stale shape
// from an older app version. A malformed entry — e.g. `{}` — would yield
// `expiresAt: undefined`, making `isAccessTokenFresh` compute `NaN` and
// then attempt a refresh with `refresh_token: undefined`. That self-heals
// (the refresh 400s and clears the session), but it's a noisy failure for
// an unrelated reason. Validate the shape on read and treat anything that
// doesn't match as "no session", mirroring sanitizeSettings (DESIGN §4.6).
function isValidTokens(value: unknown): value is SpotifyTokens {
  if (typeof value !== "object" || value === null) return false;
  const t = value as Record<string, unknown>;
  return (
    typeof t.accessToken === "string" &&
    typeof t.refreshToken === "string" &&
    typeof t.expiresAt === "number" &&
    Number.isFinite(t.expiresAt) &&
    typeof t.scope === "string"
  );
}

export function readTokens(): SpotifyTokens | null {
  try {
    const raw = sessionStorage.getItem(TOKENS_STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isValidTokens(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function writeTokens(tokens: SpotifyTokens): void {
  try {
    sessionStorage.setItem(TOKENS_STORAGE_KEY, JSON.stringify(tokens));
  } catch (error) {
    // Best-effort: log but don't throw. In-memory auth state lives in
    // useSpotifyStore and is the source of truth for the current tab —
    // failing to persist means the session won't survive a reload, but
    // the user can still finish their current task.
    console.warn("tokenStorage: writeTokens failed", error);
  }
}

export function clearTokens(): void {
  try {
    sessionStorage.removeItem(TOKENS_STORAGE_KEY);
  } catch {
    // best-effort
  }
}
