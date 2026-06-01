import {
  type MBCacheKey,
  cacheKeyForTrack,
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
    // userOverride marks the chosen Spotify URI as the row's
    // user-decided identity, mirroring the manual MB pick in
    // AmbiguousEnrichmentDialog. Without it the no-reclobber guarantee
    // would rest only on the happy path (a freshly-picked row not being
    // "pending"); a later nuke/reset back to enrichment.idle would make
    // isTrackPendingLookup re-queue the row, and reenrichAll's scoped
    // matchAllOnSpotify could silently re-search and overwrite the pick.
    // This bit only blocks RE-RESOLUTION; the follow-up MB pass below
    // still runs (enrichOneTrackMb bypasses the eligibility gate) and
    // buildEnrichmentFromOutcome preserves userOverride, so MB's
    // supplementary fill-missing-fields behavior is unaffected.
    enrichment: { status: "idle", userOverride: true },
    spotify: {
      status: "matched",
      uri: candidate.uri,
      candidates,
      score: candidate.score,
      previewUrl: candidate.previewUrl,
    },
  });
}

/**
 * Reverse a pick: clicking the already-selected match in the picker toggles
 * it off, reverting the row to an unmatched state. We land on "missing"
 * rather than "idle" because "missing" is the interactive/re-searchable
 * resting state (its status glyph stays clickable so the user can reopen
 * the picker), whereas "idle" renders inert. The display fields the pick
 * copied from the candidate stay as-is — the pre-pick local tags aren't
 * retained anywhere to restore, and reopening the picker re-searches from
 * the current title/artist anyway.
 */
export function unpickSpotifyMatch(trackId: string): void {
  const store = usePlaylistStore.getState();
  if (!store.tracksById[trackId]) return;
  store.updateTrack(trackId, { spotify: { status: "missing" } });
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
  // Derive the key via the cache module's own helper rather than an
  // inline literal, so the delete key can never drift from how entries
  // are WRITTEN (cacheKeyForTrack) if the key shape or normalization
  // ever changes. Otherwise a divergence would silently leak entries.
  const priorKey: MBCacheKey | null = priorTrack
    ? cacheKeyForTrack(priorTrack)
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
