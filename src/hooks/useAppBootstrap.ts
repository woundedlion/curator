import { useEffect } from "react";
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

export function useAppBootstrap(): void {
  useEffect(() => {
    usePlaybackStore.getState().initialize();
    void (async () => {
      await usePlaylistStore.getState().hydrateFromStorage();
      promoteSingleCandidateMatches();
    })();
    void bootstrapSpotify();
    const unsubscribe = getMusicbrainzQueue().observe((depth) => {
      useUiStore.getState().setEnrichmentQueueDepth(depth);
    });
    window.addEventListener("pagehide", flushOnHide);
    document.addEventListener("visibilitychange", flushIfHidden);
    return () => {
      window.removeEventListener("pagehide", flushOnHide);
      document.removeEventListener("visibilitychange", flushIfHidden);
      unsubscribe();
      shutdownAudioParserPool();
    };
  }, []);
}
