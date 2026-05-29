import { usePlaylistStore } from "../store/playlistStore";
import type { Track } from "../types";

// Returns the count of tracks that the MB enrichment runner would treat
// as eligible — the toolbar surfaces this as "Enriching · N remaining"
// during cold imports.
function countRemaining(state: {
  playlist: { trackIds: string[] };
  tracksById: Record<string, Track>;
}): number {
  let count = 0;
  for (const id of state.playlist.trackIds) {
    const track = state.tracksById[id];
    if (!track) continue;
    if (track.source.kind === "spotify-import") continue;
    if (track.enrichment.userOverride) continue;
    const status = track.enrichment.status;
    if (status === "idle" || status === "pending") count++;
  }
  return count;
}

// A single Zustand selector returning a primitive. The prior shape held
// two slice subscriptions plus a `useMemo([trackIds, tracksById])`,
// which never hit — both deps change reference on every mutation —
// and forced a full Toolbar re-render on every status flip, cover URL
// arrival, and Spotify match update. With the selector returning a
// number, Zustand's default Object.is equality short-circuits the
// re-render whenever the *count* is unchanged (the common case during
// post-ingest enrichment: a track flips matched→matched, the count
// doesn't move, no Toolbar reconciliation).
export function useEnrichmentRemaining(): number {
  return usePlaylistStore(countRemaining);
}
