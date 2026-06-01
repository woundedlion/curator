import { trackFromSpotifyCandidate } from "../spotify/spotifyMappers";
import { usePlaylistStore } from "../store/playlistStore";
import { useSettingsStore } from "../store/settingsStore";
import { useUiStore } from "../store/uiStore";
import type { SpotifyCandidate } from "../types";
import { enrichOneTrackMb } from "./enrichmentRunner";

// Background MB enrichment for freshly-added Spotify-matched tracks: fills
// cover art / mbRecordingId without touching the Spotify-authoritative
// displayed fields (enrichOneTrackMb uses the fill-missing policy). Fired
// per track, fire-and-forget with an explicit catch so an unexpected runner
// crash surfaces in the console rather than as a silent unhandled rejection
// (user-visible MB failures already toast inside enrichOneTrackMb).
function enrichInBackground(trackIds: string[]): void {
  const hasContact = Boolean(
    useSettingsStore.getState().settings.musicbrainzContact.trim(),
  );
  if (!hasContact || trackIds.length === 0) return;
  useUiStore
    .getState()
    .withBusy(async () => {
      for (const id of trackIds) {
        await enrichOneTrackMb(id);
      }
    })
    .catch((error) => {
      console.error("addTrackController: background enrichment crashed", error);
    });
}

/**
 * Build a draft Track from a chosen Spotify candidate and add it to the
 * playlist — appended when `atIndex` is omitted, or inserted at that slot
 * in the current order. Returns the new track id. Shared by the add-track
 * dialog (§4.7.1) and the sidebar per-track append / drag-to-insert paths
 * (§4.7.3) so all three build identical, publish-ready, MB-enriched rows.
 */
export function addCandidateTrack(
  candidate: SpotifyCandidate,
  atIndex?: number,
): string {
  const track = trackFromSpotifyCandidate(candidate);
  const store = usePlaylistStore.getState();
  if (atIndex === undefined) {
    store.addTracks([track]);
  } else {
    store.addTracksAt([track], atIndex);
  }
  enrichInBackground([track.id]);
  return track.id;
}
