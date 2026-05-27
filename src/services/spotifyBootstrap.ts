import {
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
      // fresh, and tell the user what happened.
      disconnectFromSpotify();
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
          // also drop any cached tokens (defence in depth) and emit a
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
  // added scope (e.g. playlist-modify-public). Their access tokens will
  // succeed on GET endpoints but 403 on the first publish — a confusing
  // failure mode for the user. Detect this proactively and prompt
  // reconnect with a clear message instead of waiting for the publish 403.
  const existingTokens = readTokens();
  if (existingTokens) {
    const missing = missingScopes(existingTokens);
    if (missing.length > 0) {
      console.warn(
        "Spotify token is missing required scopes; forcing reconnect",
        missing,
      );
      disconnectFromSpotify();
      useUiStore.getState().pushToast({
        kind: "error",
        message: `Spotify scopes updated — reconnect in Settings to enable: ${missing.join(", ")}`,
      });
      return;
    }
  }

  await useSpotifyStore.getState().refreshConnection(clientId);
  if (useSpotifyStore.getState().connected) {
    await useSpotifyStore.getState().loadPlaylists(clientId);
  }
}

export function bootstrapSpotify(): Promise<void> {
  if (inflight) return inflight;
  inflight = doBootstrap().finally(() => {
    inflight = null;
  });
  return inflight;
}
