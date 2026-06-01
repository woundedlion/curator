import { useEffect, useRef } from "react";
import { pruneStaleCacheEntries } from "../db/musicbrainzCache";
import { getMusicbrainzQueue } from "../enrichment/musicbrainzClient";
import { usePlaybackStore } from "../playback/playbackStore";
import { flushPendingPersist, usePlaylistStore } from "../store/playlistStore";
import { useSettingsStore } from "../store/settingsStore";
import { useSpotifyStore } from "../store/spotifyStore";
import { useUiStore } from "../store/uiStore";
import { bootstrapSpotify } from "../services/spotifyBootstrap";
import { promoteSingleCandidateMatches } from "../services/spotifyMatchRunner";
import { shutdownAudioParserPool } from "../workers/audioParserPool";

// Browsers will not await promises during `pagehide`, but they DO let an
// IndexedDB transaction whose requests are already in flight complete
// (subject to a short grace period). flushPendingPersist() issues those
// requests synchronously — the await on tx.done that follows is fine to
// abandon. We log the rejection so a stuck transaction is observable in
// developer tools, but otherwise drop it.
function flushOnHide(): void {
  flushPendingPersist().catch((error) => {
    console.warn("flushPendingPersist on hide failed", error);
  });
}

function flushIfHidden(): void {
  if (document.visibilityState === "hidden") flushOnHide();
}

// Surfaced to the user so a stalled enrichment / Spotify search after the
// network drops isn't mistaken for an app hang. The reconnect toast is
// info-level (auto-dismisses) so a brief blip doesn't leave a sticky
// notification behind.
function handleOffline(): void {
  useUiStore.getState().pushToast({
    kind: "error",
    message:
      "Network offline — Spotify and MusicBrainz lookups will fail until you reconnect.",
  });
}

function handleOnline(): void {
  useUiStore.getState().pushToast({
    kind: "info",
    message: "Network reconnected.",
  });
}

export function useAppBootstrap(): void {
  // One-time async chain guard. StrictMode's dev double-mount runs effect
  // setup→cleanup→setup on the SAME fiber, so this ref persists across it
  // and the second setup skips the chain — preventing two concurrent
  // hydrate→bootstrapSpotify→SDK-warmup runs (a double OAuth/SDK warmup). A
  // genuine remount gets a fresh fiber (fresh ref) and re-runs, as intended.
  const bootstrapChainStarted = useRef(false);
  useEffect(() => {
    usePlaybackStore.getState().initialize();
    // Hydrate the draft FIRST, then run the store-content-dependent steps:
    // promoteSingleCandidateMatches and bootstrapSpotify's follow-on side
    // effects (loadPlaylists / SDK warmup) must observe a populated store,
    // so they are sequenced after the awaited hydrate rather than racing it.
    // Each downstream step guards its own errors; the outer .catch is the
    // backstop so nothing surfaces as an unhandled rejection.
    if (!bootstrapChainStarted.current) {
      bootstrapChainStarted.current = true;
      void (async () => {
        await usePlaylistStore.getState().hydrateFromStorage();
        promoteSingleCandidateMatches();
        await bootstrapSpotify();
        // Once Spotify is connected, eagerly warm up the Web Playback SDK
        // when the user opted into full-track playback, so the first play of
        // a matched track plays the full track instead of falling back while
        // init runs. Gated on `connected`: connecting before auth completes
        // would mark the SDK permanently unavailable for the session (the
        // token callback returns empty). connectSdk() re-checks the opt-in.
        const { preferFullPlayback, spotifyClientId } =
          useSettingsStore.getState().settings;
        if (
          preferFullPlayback &&
          spotifyClientId &&
          useSpotifyStore.getState().connected
        ) {
          usePlaybackStore.getState().connectSdk();
        }
      })().catch((error) => {
        console.error("app bootstrap chain crashed", error);
      });
    }
    // Eagerly drop MB cache rows from prior `MB_CACHE_VERSION`s. Reads
    // already skip them (see `isCurrentVersion`), so this is a quota
    // reclaim, not a correctness fix — but a long-lived profile that
    // has lived through several schema bumps can otherwise accumulate
    // tens of thousands of dead rows that slow `getCacheSize` and
    // bloat IDB. Best-effort; a sweep failure is non-fatal.
    pruneStaleCacheEntries().catch((error) => {
      console.warn("pruneStaleCacheEntries failed", error);
    });
    const unsubscribe = getMusicbrainzQueue().observe((depth) => {
      useUiStore.getState().setEnrichmentQueueDepth(depth);
    });
    window.addEventListener("pagehide", flushOnHide);
    document.addEventListener("visibilitychange", flushIfHidden);
    window.addEventListener("offline", handleOffline);
    window.addEventListener("online", handleOnline);
    return () => {
      window.removeEventListener("pagehide", flushOnHide);
      document.removeEventListener("visibilitychange", flushIfHidden);
      window.removeEventListener("offline", handleOffline);
      window.removeEventListener("online", handleOnline);
      unsubscribe();
      shutdownAudioParserPool();
      // Release playback resources too: dispose the Player (drops the
      // <audio> element's event listeners and any timers) and tear down
      // the Spotify Web Playback SDK. Without this, an app unmount (test
      // teardown, route swap, HMR) leaves the SDK device + audio
      // listeners dangling. Symmetric to the initialize() call above.
      usePlaybackStore.getState().teardownPlayback();
    };
  }, []);
}
