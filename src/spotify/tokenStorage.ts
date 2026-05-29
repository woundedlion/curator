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

export function readTokens(): SpotifyTokens | null {
  try {
    const raw = sessionStorage.getItem(TOKENS_STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as SpotifyTokens;
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
