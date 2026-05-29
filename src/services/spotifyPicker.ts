import {
  cacheKeyForTrack,
  deleteCachedCandidates,
} from "../db/musicbrainzCache";
import { spotifyDisplayFieldsFromCandidate } from "../spotify/spotifyMappers";
import { usePlaylistStore } from "../store/playlistStore";
import { useSettingsStore } from "../store/settingsStore";
import { useUiStore } from "../store/uiStore";
import type { SpotifyCandidate } from "../types";
import { enrichOneTrackMb } from "./enrichmentRunner";

async function clearMbCacheForCurrentIdentity(trackId: string): Promise<void> {
  const track = usePlaylistStore.getState().tracksById[trackId];
  if (!track) return;
  try {
    await deleteCachedCandidates(cacheKeyForTrack(track));
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
  // MB-only re-run: never re-search Spotify here — the URI we just wrote
  // IS the user's chosen identity. A re-search would either auto-pick a
  // different candidate or land back on `ambiguous` (the exact state the
  // picker was opened to escape), silently reverting the user's pick.
  void useUiStore.getState().withBusy(async () => {
    await enrichOneTrackMb(trackId, { bypassCache: true });
  });
}
