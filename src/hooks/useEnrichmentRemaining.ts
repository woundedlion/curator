import { useMemo } from "react";
import { usePlaylistStore } from "../store/playlistStore";

function countRemaining(
  trackIds: string[],
  tracksById: Record<string, { source: { kind: string }; enrichment: { status: string; userOverride?: boolean } }>,
): number {
  let count = 0;
  for (const id of trackIds) {
    const track = tracksById[id];
    if (!track) continue;
    if (track.source.kind === "spotify-import") continue;
    if (track.enrichment.userOverride) continue;
    const status = track.enrichment.status;
    if (status === "idle" || status === "pending") count++;
  }
  return count;
}

export function useEnrichmentRemaining(): number {
  const trackIds = usePlaylistStore((state) => state.playlist.trackIds);
  const tracksById = usePlaylistStore((state) => state.tracksById);
  return useMemo(
    () => countRemaining(trackIds, tracksById),
    [trackIds, tracksById],
  );
}
