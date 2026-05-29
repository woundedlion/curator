import { useCallback, useRef, useState } from "react";
import {
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { arrayMove } from "@dnd-kit/sortable";
import { usePlaylistStore } from "../store/playlistStore";
import { moveSelectionMaintainingShape } from "../store/selectionHelpers";

export type DragAndDropHandlers = {
  onDragStart: (event: DragStartEvent) => void;
  onDragOver: (event: DragOverEvent) => void;
  onDragEnd: (event: DragEndEvent) => void;
  onDragCancel: () => void;
  /**
   * Live preview of the visible-id order while a multi-row drag is in
   * flight. `null` means "no preview — render `visibleTrackIds` directly"
   * (single-row drags fall back to dnd-kit's built-in row-shift animation,
   * which already does the right thing). When set, the SortableContext +
   * virtualizer render this order so unselected rows visibly slide out of
   * the way and the non-active selected rows slot into their landing
   * positions before the user releases.
   */
  dragPreviewIds: string[] | null;
  /**
   * True for the duration of a multi-row drag. Lets non-active selected
   * rows render the same "lifting" opacity that dnd-kit applies to the
   * active row, so all rows in the moving block read as a single group.
   */
  multiDragActive: boolean;
  /**
   * Id of the row the user is physically dragging, or `null` when no drag
   * is in flight. Consumed by the `DragOverlay` to render a floating
   * preview that follows the cursor.
   */
  activeDragTrackId: string | null;
  /**
   * Number of rows the user is currently carrying — equals 1 for a
   * single-row drag and the selection size for a multi-row drag. Used by
   * the overlay to render a count badge.
   */
  dragOverlayCount: number;
};

/**
 * Wires dnd-kit's drag-start / -over / -end / -cancel events into the
 * playlist store, including the multi-row drag preview and the
 * "selected-row-as-over fallback" that keeps deliberate multi-drags from
 * silently no-op'ing when the live reorder slides a selected row under
 * the cursor.
 */
export function usePlaylistDragAndDrop(
  visibleTrackIds: string[],
  allTrackIds: string[],
): DragAndDropHandlers {
  const reorderTracks = usePlaylistStore((state) => state.reorderTracks);
  const selectedTrackIds = usePlaylistStore((state) => state.selectedTrackIds);
  const selectOnly = usePlaylistStore((state) => state.selectOnly);

  const [dragPreviewIds, setDragPreviewIds] = useState<string[] | null>(null);
  const [multiDragActive, setMultiDragActive] = useState(false);
  const [activeDragTrackId, setActiveDragTrackId] = useState<string | null>(
    null,
  );
  const [dragOverlayCount, setDragOverlayCount] = useState(0);
  // dnd-kit's `over.id` can settle on a selected row while the preview is
  // shifting things around (a non-active selected row slides under the
  // cursor's screen position). The drop semantics treat "over a selected
  // row" as a no-op, which would silently abort the move the user just
  // built up visually. To avoid that, we remember the most recent
  // UNSELECTED over-id we saw during the drag and use it on release as a
  // fallback anchor when the final over-id is on a selected row. Cleared
  // at drag start/cancel.
  const lastUnselectedOverIdRef = useRef<string | null>(null);

  const onDragStart = useCallback(
    (event: DragStartEvent) => {
      const activeId = String(event.active.id);
      lastUnselectedOverIdRef.current = null;
      setActiveDragTrackId(activeId);
      // If the dragged row isn't part of the current selection, the drag
      // should affect only that row. Make this visible by replacing the
      // selection so the user sees what they're carrying.
      if (!selectedTrackIds.has(activeId)) {
        selectOnly(activeId);
        setMultiDragActive(false);
        setDragOverlayCount(1);
        return;
      }
      setMultiDragActive(selectedTrackIds.size > 1);
      setDragOverlayCount(selectedTrackIds.size);
    },
    [selectedTrackIds, selectOnly],
  );

  const onDragOver = useCallback(
    (event: DragOverEvent) => {
      const { active, over } = event;
      if (!over) return;
      const activeId = String(active.id);
      const overId = String(over.id);
      const selection = usePlaylistStore.getState().selectedTrackIds;
      // Only multi-row drags need a preview override — dnd-kit handles
      // the single-row case natively.
      if (selection.size <= 1 || !selection.has(activeId)) {
        if (dragPreviewIds !== null) setDragPreviewIds(null);
        return;
      }
      // Hovering over a selected row keeps the last preview as-is (the
      // live reorder can scoot a selected row under the cursor mid-drag,
      // but the user's intent hasn't moved — keep showing the last valid
      // landing).
      if (selection.has(overId)) return;
      lastUnselectedOverIdRef.current = overId;
      const next = moveSelectionMaintainingShape(
        visibleTrackIds,
        selection,
        activeId,
        overId,
      );
      if (next === visibleTrackIds) {
        if (dragPreviewIds !== null) setDragPreviewIds(null);
      } else if (next !== dragPreviewIds) {
        setDragPreviewIds(next);
      }
    },
    [visibleTrackIds, dragPreviewIds],
  );

  const onDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      const lastUnselectedOver = lastUnselectedOverIdRef.current;
      setDragPreviewIds(null);
      setMultiDragActive(false);
      setActiveDragTrackId(null);
      setDragOverlayCount(0);
      lastUnselectedOverIdRef.current = null;
      if (!over) return;
      const activeId = String(active.id);
      const overFromEvent = String(over.id);

      // After onDragStart, the selection always contains activeId. So
      // the "current selection" is the set we should move.
      const currentSelection = usePlaylistStore.getState().selectedTrackIds;

      if (currentSelection.size > 1) {
        // Prefer the live event's over-id, but if it landed on a selected
        // row (because the preview shifted things under the cursor), fall
        // back to the last unselected over we saw. Without this fallback
        // the user's deliberate multi-drag would silently no-op.
        const overId = currentSelection.has(overFromEvent)
          ? lastUnselectedOver
          : overFromEvent;
        if (!overId || currentSelection.has(overId)) return;
        const newVisibleOrder = moveSelectionMaintainingShape(
          visibleTrackIds,
          currentSelection,
          activeId,
          overId,
        );
        if (newVisibleOrder === visibleTrackIds) return;
        // Map the new visible-list order back into the full track-id
        // list, preserving hidden rows (filtered by Hide-unmatched) at
        // their original positions.
        const visibleSet = new Set(visibleTrackIds);
        let cursor = 0;
        const newAll = allTrackIds.map((id) =>
          visibleSet.has(id) ? newVisibleOrder[cursor++]! : id,
        );
        reorderTracks(newAll);
        return;
      }

      // Single-row drag. dnd-kit's `over.id` comes from the SortableContext's
      // visible items list, so we must compute the move in *visible* terms
      // and then map the new visible order back into `allTrackIds`. Doing
      // arrayMove directly on `allTrackIds` would land the row before/after
      // hidden rows that sit between the visible source and target.
      if (activeId === overFromEvent) return;
      const visibleOld = visibleTrackIds.indexOf(activeId);
      const visibleNew = visibleTrackIds.indexOf(overFromEvent);
      if (visibleOld === -1 || visibleNew === -1) return;
      const newVisibleOrder = arrayMove(visibleTrackIds, visibleOld, visibleNew);
      const visibleSet = new Set(visibleTrackIds);
      let cursor = 0;
      const newAll = allTrackIds.map((id) =>
        visibleSet.has(id) ? newVisibleOrder[cursor++]! : id,
      );
      reorderTracks(newAll);
    },
    [allTrackIds, visibleTrackIds, reorderTracks],
  );

  const onDragCancel = useCallback(() => {
    setDragPreviewIds(null);
    setMultiDragActive(false);
    setActiveDragTrackId(null);
    setDragOverlayCount(0);
    lastUnselectedOverIdRef.current = null;
  }, []);

  return {
    onDragStart,
    onDragOver,
    onDragEnd,
    onDragCancel,
    dragPreviewIds,
    multiDragActive,
    activeDragTrackId,
    dragOverlayCount,
  };
}
