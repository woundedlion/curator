import { useEffect } from "react";
import { pruneStaleCacheEntries } from "../db/musicbrainzCache";
import { getMusicbrainzQueue } from "../enrichment/musicbrainzClient";
import { usePlaybackStore } from "../playback/playbackStore";
import { flushPendingPersist, usePlaylistStore } from "../store/playlistStore";
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
  useEffect(() => {
    usePlaybackStore.getState().initialize();
    void (async () => {
      await usePlaylistStore.getState().hydrateFromStorage();
      promoteSingleCandidateMatches();
    })();
    bootstrapSpotify().catch((error) => {
      // doBootstrap handles its own user-facing errors; this is a
      // belt-and-suspenders guard so an unexpected throw can't surface as
      // an unhandled rejection.
      console.error("bootstrapSpotify crashed", error);
    });
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
