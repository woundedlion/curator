import { usePlaylistStore } from "../store/playlistStore";
import type { Track } from "../types";

// Spotify-side counterpart to useEnrichmentRemaining. Counts tracks the
// Spotify match runner would treat as eligible — toolbar surfaces this
// as "Spotify · N remaining".
function countRemaining(state: {
  playlist: { trackIds: string[] };
  tracksById: Record<string, Track>;
}): number {
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
