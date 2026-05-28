import { SPOTIFY_AUTO_RECONNECT_SUPPRESSED_KEY } from "../constants";
import {
  beginAuthFlow,
  clearCallbackParams,
  completeAuthFlow,
  disconnectFromSpotify,
  missingScopes,
  readAuthCallback,
} from "../spotify/authFlow";
import { readTokens } from "../spotify/tokenStorage";
import { useSettingsStore } from "../store/settingsStore";
import { useSpotifyStore } from "../store/spotifyStore";
import { useUiStore } from "../store/uiStore";

export function markAutoReconnectSuppressed(): void {
  sessionStorage.setItem(SPOTIFY_AUTO_RECONNECT_SUPPRESSED_KEY, "1");
}

export function clearAutoReconnectSuppression(): void {
  sessionStorage.removeItem(SPOTIFY_AUTO_RECONNECT_SUPPRESSED_KEY);
}

function isAutoReconnectSuppressed(): boolean {
  return sessionStorage.getItem(SPOTIFY_AUTO_RECONNECT_SUPPRESSED_KEY) === "1";
}

function describeAuthError(error: string): string {
  switch (error) {
    case "access_denied":
      return "Spotify authorization was denied — try again from Settings if this was a mistake";
    case "invalid_client":
      return "Spotify rejected the Client ID — verify it in Settings";
    case "invalid_scope":
      return "Spotify rejected the requested scopes — reconnect from Settings";
    default:
      return `Spotify connect failed (${error})`;
  }
}

// Module-level inflight guard. React StrictMode double-mounts the bootstrap
// effect in dev, and the redirect-back path can also run twice during
// natural navigation. Concurrent completeAuthFlow calls would race on the
// single-use auth code, with one succeeding and the other producing a
// spurious "Spotify connect failed" toast. Sharing one promise serializes
// both into a single bootstrap run.
let inflight: Promise<void> | null = null;

async function doBootstrap(): Promise<void> {
  const settings = useSettingsStore.getState().settings;
  const clientId = settings.spotifyClientId;
  if (!clientId) return;

  const callback = readAuthCallback();
  if (callback) {
    if (callback.kind === "error") {
      // User denied consent or Spotify rejected the request. Reset any
      // partially-stored PKCE keys so a future Connect button starts
      // fresh, and tell the user what happened. Also suppress
      // auto-reconnect this session — without it, the bootstrap would
      // immediately redirect the user back to Spotify on every refresh.
      disconnectFromSpotify();
      markAutoReconnectSuppressed();
      useUiStore.getState().pushToast({
        kind: "error",
        message: describeAuthError(callback.error),
      });
      clearCallbackParams();
      return;
    }
    const alreadyHasTokens = readTokens() !== null;
    if (!alreadyHasTokens) {
      try {
        await completeAuthFlow(clientId, settings.spotifyRedirectUri, callback);
      } catch (error) {
        // Only treat as a real failure if tokens didn't end up present.
        // (A concurrent invocation may have already exchanged the code.)
        if (!readTokens()) {
          console.error("Spotify connect failed", error);
          // completeAuthFlow already clears PKCE keys on failure, but
          // also drop any cached tokens (defense in depth) and emit a
          // clear toast.
          disconnectFromSpotify();
          useUiStore.getState().pushToast({
            kind: "error",
            message: "Spotify connect failed — try reconnecting from Settings",
          });
        }
      }
    }
    clearCallbackParams();
  }

  // Tokens cached from an earlier authorize call may pre-date a newly
  // added scope (e.g. playlist-modify-public). Drop them so the
  // auto-reconnect below picks the user up with the current scope set
  // instead of waiting for the eventual 403 on first publish.
  const existingTokens = readTokens();
  if (existingTokens) {
    const missing = missingScopes(existingTokens);
    if (missing.length > 0) {
      console.warn(
        "Spotify token is missing required scopes; forcing reconnect",
        missing,
      );
      disconnectFromSpotify();
    }
  }

  await useSpotifyStore.getState().refreshConnection(clientId);
  const { connected, status } = useSpotifyStore.getState();
  if (connected) {
    await useSpotifyStore.getState().loadPlaylists(clientId);
    return;
  }

  // Skip auto-reconnect when we're rate-limited rather than
  // legitimately disconnected. The OAuth redirect itself can't
  // proceed (token exchange shares the same per-app quota that just
  // 429'd us), and dropping the user on the Spotify authorize page
  // mid-rate-limit is confusing. The Settings dialog surfaces the
  // breaker countdown so the user knows what's happening; once the
  // breaker closes a refresh will auto-reconnect them.
  if (status === "rate-limited") return;

  // Auto-reconnect: clientId is configured but we couldn't establish a
  // session (no tokens, refresh expired, or scopes were stripped above).
  // Redirect to Spotify immediately so the user lands back connected.
  // Suppressed for the rest of the tab if a prior callback returned
  // ?error= (see markAutoReconnectSuppressed above) — without that
  // guard, denial would loop back to Spotify on every refresh.
  if (isAutoReconnectSuppressed()) return;
  await beginAuthFlow(clientId, settings.spotifyRedirectUri);
}

export function bootstrapSpotify(): Promise<void> {
  if (inflight) return inflight;
  inflight = doBootstrap().finally(() => {
    inflight = null;
  });
  return inflight;
}
