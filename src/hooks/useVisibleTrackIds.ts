import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { usePlaylistStore } from "../store/playlistStore";

export type VisibilityResult = {
  visibleTrackIds: string[];
  hiddenCount: number;
};

export function useVisibleTrackIds(): VisibilityResult {
  // One subscription, shallow-compared, so the hook re-runs at most
  // once per store mutation regardless of how many of the three
  // referenced slices changed.
  const { trackIds, hideUnmatched, tracksById } = usePlaylistStore(
    useShallow((state) => ({
      trackIds: state.playlist.trackIds,
      hideUnmatched: state.playlist.hideUnmatched,
      tracksById: state.tracksById,
    })),
  );

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
