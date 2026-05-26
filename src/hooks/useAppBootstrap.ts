import { useEffect } from "react";
import { getMusicbrainzQueue } from "../enrichment/musicbrainzClient";
import { usePlaybackStore } from "../playback/playbackStore";
import { flushPendingPersist, usePlaylistStore } from "../store/playlistStore";
import { useUiStore } from "../store/uiStore";
import { bootstrapSpotify } from "../services/spotifyBootstrap";
import { promoteSingleCandidateMatches } from "../services/spotifyMatchRunner";
import { shutdownAudioParserPool } from "../workers/audioParserPool";

function flushOnHide(): void {
  void flushPendingPersist();
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
