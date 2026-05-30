import { usePlaylistStore } from "../store/playlistStore";

// Derive the selector's parameter from the live store rather than a
// hand-written structural slice, so a rename of any field read here is
// a compile error rather than a silent drift. (Mirrors the typing of
// useEnrichmentRemaining.)
type PlaylistState = ReturnType<typeof usePlaylistStore.getState>;

// Spotify-side counterpart to useEnrichmentRemaining. Counts tracks the
// Spotify match runner would treat as eligible — toolbar surfaces this
// as "Spotify · N remaining".
function countRemaining(state: PlaylistState): number {
  let count = 0;
  for (const id of state.playlist.trackIds) {
    const track = state.tracksById[id];
    if (!track) continue;
    if (track.source.kind === "spotify-import") continue;
    const status = track.spotify.status;
    if (status === "idle" || status === "pending") count++;
  }
  return count;
}

export function useSpotifyRemaining(): number {
  return usePlaylistStore(countRemaining);
}
