import {
  clearCallbackParams,
  completeAuthFlow,
  readCallbackParams,
} from "../spotify/authFlow";
import { readTokens } from "../spotify/tokenStorage";
import { useSettingsStore } from "../store/settingsStore";
import { useSpotifyStore } from "../store/spotifyStore";
import { useUiStore } from "../store/uiStore";

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

  const callback = readCallbackParams();
  if (callback) {
    const alreadyHasTokens = readTokens() !== null;
    if (!alreadyHasTokens) {
      try {
        await completeAuthFlow(clientId, settings.spotifyRedirectUri, callback);
      } catch (error) {
        // Only treat as a real failure if tokens didn't end up present.
        // (A concurrent invocation may have already exchanged the code.)
        if (!readTokens()) {
          console.error("Spotify connect failed", error);
          useUiStore.getState().pushToast({
            kind: "error",
            message: "Spotify connect failed",
          });
        }
      }
    }
    clearCallbackParams();
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
