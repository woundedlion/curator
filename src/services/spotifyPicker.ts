import {
  type MBCacheKey,
  deleteCachedCandidates,
} from "../db/musicbrainzCache";
import { spotifyDisplayFieldsFromCandidate } from "../spotify/spotifyMappers";
import { usePlaylistStore } from "../store/playlistStore";
import { useSettingsStore } from "../store/settingsStore";
import { useUiStore } from "../store/uiStore";
import type { SpotifyCandidate } from "../types";
import { enrichOneTrackMb } from "./enrichmentRunner";

async function clearMbCacheForKey(
  trackId: string,
  key: MBCacheKey,
): Promise<void> {
  try {
    await deleteCachedCandidates(key);
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
  // Capture the row's PRE-PICK identity BEFORE applyCandidateToTrack
  // overwrites title/artist/album from the chosen Spotify candidate.
  // If we read the track after the update, the cache delete would key
  // off the new identity — whose entry doesn't exist yet — and the
  // stale entry under the old (title, artist, album) tuple would
  // remain in IDB, slowly leaking entries on every pick. bypassCache
  // on the follow-up enrichment masks the immediate symptom, but the
  // leak compounds across rows that get re-picked.
  const priorTrack = usePlaylistStore.getState().tracksById[trackId];
  const priorKey: MBCacheKey | null = priorTrack
    ? {
        title: priorTrack.title,
        artist: priorTrack.artist,
        album: priorTrack.album,
      }
    : null;
  applyCandidateToTrack(trackId, candidate, candidates);
  if (priorKey) await clearMbCacheForKey(trackId, priorKey);
  const hasContact = Boolean(
    useSettingsStore.getState().settings.musicbrainzContact.trim(),
  );
  if (!hasContact) return;
  // MB-only re-run: never re-search Spotify here — the URI we just wrote
  // IS the user's chosen identity. A re-search would either auto-pick a
  // different candidate or land back on `ambiguous` (the exact state the
  // picker was opened to escape), silently reverting the user's pick.
  // Fire-and-forget on purpose, but with an explicit .catch so an
  // unexpected crash inside the runner surfaces in the console instead
  // of becoming a silent unhandled rejection. User-visible MB failures
  // are toasted inside enrichOneTrackMb already.
  useUiStore
    .getState()
    .withBusy(async () => {
      await enrichOneTrackMb(trackId, { bypassCache: true });
    })
    .catch((error) => {
      console.error("spotifyPicker: post-pick enrichment crashed", error);
    });
}
