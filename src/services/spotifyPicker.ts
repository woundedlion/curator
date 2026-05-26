import { deleteCachedCandidates } from "../db/musicbrainzCache";
import { normalizeForMatching } from "../metadata/normalizers";
import { spotifyDisplayFieldsFromCandidate } from "../spotify/spotifyMappers";
import { usePlaylistStore } from "../store/playlistStore";
import { useSettingsStore } from "../store/settingsStore";
import { useUiStore } from "../store/uiStore";
import type { SpotifyCandidate, Track } from "../types";
import { reenrichTrack } from "./enrichmentRunner";

function cacheKeyFor(track: Track) {
  return {
    title: normalizeForMatching(track.title),
    artist: normalizeForMatching(track.artist),
    album: normalizeForMatching(track.album),
  };
}

async function clearMbCacheForCurrentIdentity(trackId: string): Promise<void> {
  const track = usePlaylistStore.getState().tracksById[trackId];
  if (!track) return;
  try {
    await deleteCachedCandidates(cacheKeyFor(track));
  } catch (error) {
    console.warn("spotifyPicker: cache clear failed", { trackId, error });
  }
}

function applyCandidateToTrack(
  trackId: string,
  candidate: SpotifyCandidate,
  candidates: SpotifyCandidate[],
): void {
  const store = usePlaylistStore.getState();
  const track = store.tracksById[trackId];
  if (!track) return;
  store.updateTrack(trackId, {
    ...spotifyDisplayFieldsFromCandidate(candidate),
    enrichment: { status: "idle" },
    spotify: {
      status: "matched",
      uri: candidate.uri,
      candidates,
      score: candidate.score,
      previewUrl: candidate.previewUrl,
    },
  });
}

export async function pickSpotifyCandidate(
  trackId: string,
  candidate: SpotifyCandidate,
  candidates: SpotifyCandidate[],
): Promise<void> {
  applyCandidateToTrack(trackId, candidate, candidates);
  await clearMbCacheForCurrentIdentity(trackId);
  const hasContact = Boolean(
    useSettingsStore.getState().settings.musicbrainzContact.trim(),
  );
  if (!hasContact) return;
  void useUiStore.getState().withBusy(async () => {
    await reenrichTrack(trackId);
  });
}
