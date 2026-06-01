import { usePlaylistStore } from "../store/playlistStore";

// Derive the selector's parameter from the live store rather than a
// hand-written structural slice: ReturnType<typeof getState> is the
// real PlaylistStore shape, so a rename of `playlist.trackIds`,
// `tracksById`, or any field this selector reads becomes a compile
// error here instead of silently drifting.
type PlaylistState = ReturnType<typeof usePlaylistStore.getState>;

// Returns the count of tracks that the MB enrichment runner would treat
// as eligible — the toolbar surfaces this as "Enriching · N remaining"
// during cold imports.
function countRemaining(state: PlaylistState): number {
  let count = 0;
  for (const id of state.playlist.trackIds) {
    const track = state.tracksById[id];
    if (!track) continue;
    if (track.source.kind === "spotify-import") continue;
    if (track.enrichment.userOverride) continue;
    // A track Spotify resolved as having NO match will never reach MB
    // enrichment — the runner gates MB on a Spotify match (see
    // enrichmentEligibility: "missing tracks stay un-enriched"). Counting
    // it as "remaining" strands the "Enriching · N remaining" indicator
    // permanently above zero, since nothing will ever decrement it.
    if (track.spotify.status === "missing") continue;
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
