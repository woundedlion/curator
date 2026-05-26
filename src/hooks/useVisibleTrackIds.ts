import { useMemo } from "react";
import { usePlaylistStore } from "../store/playlistStore";

export type VisibilityResult = {
  visibleTrackIds: string[];
  hiddenCount: number;
};

export function useVisibleTrackIds(): VisibilityResult {
  const trackIds = usePlaylistStore((state) => state.playlist.trackIds);
  const hideUnmatched = usePlaylistStore(
    (state) => state.playlist.hideUnmatched,
  );
  const tracksById = usePlaylistStore((state) => state.tracksById);

  return useMemo(() => {
    if (!hideUnmatched) return { visibleTrackIds: trackIds, hiddenCount: 0 };
    const visible: string[] = [];
    let hidden = 0;
    for (const id of trackIds) {
      const track = tracksById[id];
      if (track?.spotify.status === "missing") hidden++;
      else visible.push(id);
    }
    return { visibleTrackIds: visible, hiddenCount: hidden };
  }, [trackIds, hideUnmatched, tracksById]);
}
