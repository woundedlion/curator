import { useCallback, useRef, useState } from "react";
import {
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { arrayMove } from "@dnd-kit/sortable";
import { usePlaylistStore } from "../store/playlistStore";
import { moveSelectionMaintainingShape } from "../store/selectionHelpers";

// Given a preview/visible order and an `over` row that turned out to
// be a selected row (the live preview slid it under the cursor), find
// the closest UNSELECTED row in the same order. Searches forward
// then backward from the over-position so the result is the nearest
// drop target the user could plausibly have meant. Returns null when
// every row in the order is selected — in that case the move would
// be a no-op anyway.
export function nearestUnselectedFallback(
  order: ReadonlyArray<string>,
  overId: string,
  selection: ReadonlySet<string>,
): string | null {
  const overIndex = order.indexOf(overId);
  if (overIndex === -1) return null;
  for (let i = overIndex + 1; i < order.length; i++) {
    const id = order[i]!;
    if (!selection.has(id)) return id;
  }
  for (let i = overIndex - 1; i >= 0; i--) {
    const id = order[i]!;
    if (!selection.has(id)) return id;
  }
  return null;
}

// Shallow positional equality for id arrays. `moveSelectionMaintainingShape`
// returns a FRESH array on every call, so a reference check against the
// previous preview is always true — onDragOver fires very frequently and
// would re-render the SortableContext + virtualizer on every event even
// when the computed landing order is identical. Comparing by value collapses
// those redundant writes to one per genuine layout change.
function sameOrder(
  a: ReadonlyArray<string>,
  b: ReadonlyArray<string> | null,
): boolean {
  if (b === null || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

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
  // Synchronous mirror of `dragPreviewIds`. React batches state writes
  // (especially under StrictMode and inside the `act(...)` blocks the
  // tests use), so a fresh write from `onDragOver` is NOT visible via
  // the `dragPreviewIds` state closure when `onDragEnd` runs in the
  // same tick. The ref captures the latest preview synchronously so
  // the fallback at drop time always sees the order the user
  // actually released on. State remains the source of truth for
  // rendering; the ref is an internal implementation detail.
  const dragPreviewIdsRef = useRef<string[] | null>(null);
  const setDragPreviewBoth = (value: string[] | null): void => {
    dragPreviewIdsRef.current = value;
    setDragPreviewIds(value);
  };

  const onDragStart = useCallback(
    (event: DragStartEvent) => {
      const activeId = String(event.active.id);
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
        if (dragPreviewIdsRef.current !== null) setDragPreviewBoth(null);
        return;
      }
      // Hovering over a selected row keeps the last preview as-is (the
      // live reorder can scoot a selected row under the cursor mid-drag,
      // but the user's intent hasn't moved — keep showing the last valid
      // landing).
      if (selection.has(overId)) return;
      const next = moveSelectionMaintainingShape(
        visibleTrackIds,
        selection,
        activeId,
        overId,
      );
      if (next === visibleTrackIds) {
        if (dragPreviewIdsRef.current !== null) setDragPreviewBoth(null);
      } else if (!sameOrder(next, dragPreviewIdsRef.current)) {
        setDragPreviewBoth(next);
      }
    },
    [visibleTrackIds],
  );

  const onDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      // Read the preview from the synchronous ref — `dragPreviewIds`
      // state may not be committed yet if onDragOver and onDragEnd
      // batched in the same React tick.
      const previewAtRelease = dragPreviewIdsRef.current;
      setDragPreviewBoth(null);
      setMultiDragActive(false);
      setActiveDragTrackId(null);
      setDragOverlayCount(0);
      if (!over) return;
      const activeId = String(active.id);
      const overFromEvent = String(over.id);

      // After onDragStart, the selection always contains activeId. So
      // the "current selection" is the set we should move.
      const currentSelection = usePlaylistStore.getState().selectedTrackIds;

      if (currentSelection.size > 1) {
        // Prefer the live event's over-id, but if it landed on a
        // selected row (because the preview shifted things under the
        // cursor), derive the fallback from the preview order. The
        // preview is only set when the user has hovered at least one
        // UNSELECTED row during the drag — `onDragOver` returns early
        // for selected overs and never writes the preview. So
        // `previewAtRelease === null` is the signal that the user
        // never crossed an unselected row, which we treat as "no real
        // drop target picked" (no-op). When the preview exists,
        // `nearestUnselectedFallback` walks it for the closest
        // unselected slot near the release point — that's the row the
        // user visually released on under the cursor.
        let overId: string | null = overFromEvent;
        if (currentSelection.has(overFromEvent)) {
          overId = previewAtRelease
            ? nearestUnselectedFallback(
                previewAtRelease,
                overFromEvent,
                currentSelection,
              )
            : null;
        }
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
    setDragPreviewBoth(null);
    setMultiDragActive(false);
    setActiveDragTrackId(null);
    setDragOverlayCount(0);
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
