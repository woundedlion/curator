import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  DndContext,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { PLAYLIST_SCROLL_KEY, ROW_HEIGHT_PX } from "../constants";
import { usePlaylistStore } from "../store/playlistStore";
import { moveSelectionMaintainingShape } from "../store/selectionHelpers";
import { ConfirmDialog } from "./ConfirmDialog";
import { IconButton } from "./IconButton";
import { TrashIcon } from "./icons";
import type { RowClickModifiers } from "./SortableTrackRow";
import { SortableTrackRow } from "./SortableTrackRow";
import type { SortField, Track } from "../types";

type Props = {
  visibleTrackIds: string[];
  onPickSpotifyMatch: (trackId: string) => void;
  onPickEnrichmentMatch: (trackId: string) => void;
  onReEnrich: (trackId: string) => void;
};

function bulkDeleteMessage(count: number): string {
  return `Remove ${count} selected tracks? You can undo this while the tab is open.`;
}

const HEADERS: { field: SortField; label: string; width: string }[] = [
  { field: "index", label: "Idx", width: "w-12" },
  { field: "artist", label: "Artist", width: "w-48" },
  { field: "title", label: "Title", width: "flex-1" },
  { field: "year", label: "Year", width: "w-16" },
  { field: "originalYear", label: "Orig", width: "w-16" },
  { field: "album", label: "Album", width: "w-56" },
  { field: "trackNo", label: "#", width: "w-12" },
];

function indicatorFor(
  field: SortField,
  current: SortField | undefined,
  dir: "asc" | "desc" | undefined,
): string {
  if (current !== field) return "";
  return dir === "asc" ? "▲" : "▼";
}

// Distance the pointer must travel before a press becomes a rubber-band drag
// (rather than a click). Matches dnd-kit's activation distance so the two
// interaction models feel symmetric.
const RUBBERBAND_THRESHOLD_PX = 6;

// Background colors are applied per-row in SortableTrackRow; the table only
// needs to detect which rows fall under the rubber-band rectangle.

type RubberbandRect = {
  // Viewport-relative pixel coordinates for the visible rectangle.
  left: number;
  top: number;
  width: number;
  height: number;
};

type PendingPointerState = {
  startClientX: number;
  startClientY: number;
  startContainerY: number;
  startScrollTop: number;
  // Whether shift/meta/ctrl was held at press-down — additive vs replace.
  additive: boolean;
  // Selection ids before the rubber-band started (used for additive merge).
  baselineSelection: ReadonlySet<string>;
  // Once movement exceeds the threshold we flip to true and start rendering.
  active: boolean;
  pointerId: number;
};

function isInteractiveTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  // Anything inside an actionable control or marked as no-rubberband bails.
  return Boolean(
    target.closest(
      'button, a, input, select, textarea, [role="button"], [data-no-rubberband="true"]',
    ),
  );
}

// One-shot guard: we restore scroll exactly once per page load, on the first
// non-empty mount of the table. Subsequent remounts (e.g. Clear → re-add)
// shouldn't fight the user's expectation of starting at the top.
let scrollAlreadyRestored = false;

function readSavedScrollTop(): number | null {
  try {
    const raw = sessionStorage.getItem(PLAYLIST_SCROLL_KEY);
    if (raw === null) return null;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  } catch {
    return null;
  }
}

function writeSavedScrollTop(value: number): void {
  try {
    sessionStorage.setItem(PLAYLIST_SCROLL_KEY, String(Math.max(0, value)));
  } catch {
    // sessionStorage write can fail in private-mode or when quota is hit;
    // scroll restoration is a nice-to-have, not worth surfacing.
  }
}

export function PlaylistTable({
  visibleTrackIds,
  onPickSpotifyMatch,
  onPickEnrichmentMatch,
  onReEnrich,
}: Props) {
  const tracksById = usePlaylistStore((state) => state.tracksById);
  const sort = usePlaylistStore((state) => state.playlist.sort);
  const setSort = usePlaylistStore((state) => state.setSort);
  const reorderTracks = usePlaylistStore((state) => state.reorderTracks);
  const removeTracks = usePlaylistStore((state) => state.removeTracks);
  const allTrackIds = usePlaylistStore((state) => state.playlist.trackIds);
  const selectedTrackIds = usePlaylistStore((state) => state.selectedTrackIds);
  const selectOnly = usePlaylistStore((state) => state.selectOnly);
  const toggleSelection = usePlaylistStore((state) => state.toggleSelection);
  const extendSelectionTo = usePlaylistStore(
    (state) => state.extendSelectionTo,
  );
  const setSelection = usePlaylistStore((state) => state.setSelection);
  const clearSelection = usePlaylistStore((state) => state.clearSelection);

  const parentRef = useRef<HTMLDivElement | null>(null);
  const rowVirtualizer = useVirtualizer({
    count: visibleTrackIds.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT_PX,
    overscan: 8,
  });

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  // Rubber-band drag state. The pending state holds press-down info; once
  // we cross the threshold we flip `active` and start rendering `rect`.
  const pendingRef = useRef<PendingPointerState | null>(null);
  const suppressClickRef = useRef(false);
  const [rubberbandRect, setRubberbandRect] = useState<RubberbandRect | null>(
    null,
  );

  // Snapshot of the visible-id list at press-down; rubber-band selection is
  // computed against this, so a sort or filter change mid-drag can't corrupt
  // the index math.
  const visibleAtPressRef = useRef<string[]>([]);
  // Most recently visible ids — used by the live pointermove handler without
  // taking a fresh closure each render.
  const visibleIdsRef = useRef<string[]>(visibleTrackIds);
  useEffect(() => {
    visibleIdsRef.current = visibleTrackIds;
  }, [visibleTrackIds]);

  // ─── Scroll position: restore once after hydration, save while scrolling ──
  // Restoration has to wait until the virtualizer has set the inner div's
  // total height — until then, the parent's max scrollTop is 0 and any
  // assignment clamps. Keying off visibleTrackIds.length flipping non-zero
  // ensures we run after the first measured render.
  useEffect(() => {
    if (scrollAlreadyRestored) return;
    if (visibleTrackIds.length === 0) return;
    const el = parentRef.current;
    if (!el) return;
    const saved = readSavedScrollTop();
    scrollAlreadyRestored = true;
    if (saved === null || saved === 0) return;
    // The virtualizer sizes its content via the inner spacer's height. Wait
    // one frame so layout is committed before we assign scrollTop — without
    // this, the assignment can clamp to a too-small scrollHeight on first
    // render and the user lands a few pixels above their saved position.
    requestAnimationFrame(() => {
      el.scrollTop = saved;
    });
  }, [visibleTrackIds.length]);

  // Save scrollTop throttled to one write per ~100ms. Anything finer floods
  // sessionStorage during a fast wheel scroll without buying any accuracy.
  useEffect(() => {
    const el = parentRef.current;
    if (!el) return;
    let pending: number | null = null;
    function onScroll() {
      if (pending !== null) return;
      pending = window.setTimeout(() => {
        pending = null;
        if (el) writeSavedScrollTop(el.scrollTop);
      }, 100);
    }
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      if (pending !== null) clearTimeout(pending);
    };
  }, []);

  // Confirm-dialog state for destructive bulk deletes. `pendingDeleteIds`
  // is the snapshot taken at the moment the user requested the delete —
  // the live selection may have shifted by the time the user clicks
  // Confirm, so we honor what they had selected when they pressed.
  const [pendingDeleteIds, setPendingDeleteIds] = useState<string[] | null>(
    null,
  );

  // Delete every currently-selected row. Confirms when ≥2 are selected so
  // an accidental press of Delete (or click of the header Delete button)
  // doesn't wipe a whole multi-selection. Bound by the live store state so
  // the same helper works for the keyboard handler, the header button, and
  // the per-row trash icon when the row belongs to the selection.
  const deleteSelectionWithConfirm = useCallback(() => {
    const ids = Array.from(
      usePlaylistStore.getState().selectedTrackIds,
    );
    if (ids.length === 0) return;
    if (ids.length > 1) {
      setPendingDeleteIds(ids);
      return;
    }
    removeTracks(ids);
  }, [removeTracks]);

  // Per-row trash icon. When the clicked row is part of the active
  // selection, the click affects the whole selection (just like the
  // keyboard Delete shortcut and the header Delete button). Otherwise it
  // removes only that row and skips the confirm — same low-friction
  // behavior as before.
  const handleRowRemove = useCallback(
    (trackId: string) => {
      const selection = usePlaylistStore.getState().selectedTrackIds;
      if (selection.has(trackId) && selection.size > 1) {
        setPendingDeleteIds(Array.from(selection));
        return;
      }
      removeTracks([trackId]);
    },
    [removeTracks],
  );

  const confirmPendingDelete = useCallback(() => {
    if (pendingDeleteIds) removeTracks(pendingDeleteIds);
    setPendingDeleteIds(null);
  }, [pendingDeleteIds, removeTracks]);

  // ─── Keyboard: Delete = bulk remove, Esc = clear selection ───────────────
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const target = e.target;
      // Ignore when the user is typing into a field or content-editable area,
      // or when focus is on a row-level icon button (Delete on the per-row
      // trash icon already runs its own click handler; a global Delete here
      // would double-fire). Body-level focus and row-level (role="row")
      // focus are the only places these shortcuts should activate.
      if (target instanceof Element) {
        if (
          target.closest(
            'input, textarea, select, button, a, [contenteditable="true"]',
          )
        ) {
          return;
        }
      }
      if (e.key === "Escape") {
        if (selectedTrackIds.size === 0) return;
        clearSelection();
        e.preventDefault();
        return;
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        if (selectedTrackIds.size === 0) return;
        deleteSelectionWithConfirm();
        e.preventDefault();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectedTrackIds, clearSelection, deleteSelectionWithConfirm]);

  // ─── Row click: selection w/ modifiers ──────────────────────────────────
  const handleRowClick = useCallback(
    (trackId: string, modifiers: RowClickModifiers) => {
      if (suppressClickRef.current) {
        suppressClickRef.current = false;
        return;
      }
      if (modifiers.shift) {
        extendSelectionTo(trackId, visibleIdsRef.current);
        return;
      }
      if (modifiers.meta) {
        toggleSelection(trackId);
        return;
      }
      // Plain click on the sole highlighted row deselects it — the row's
      // own glyph becomes the "off" toggle, so users don't have to reach
      // for Esc or click an empty area to clear a single selection. Read
      // selection from the store directly to avoid stale-closure issues.
      const current = usePlaylistStore.getState().selectedTrackIds;
      if (current.size === 1 && current.has(trackId)) {
        clearSelection();
        return;
      }
      selectOnly(trackId);
    },
    [extendSelectionTo, toggleSelection, selectOnly, clearSelection],
  );

  // ─── Rubber-band: pointerdown / move / up ───────────────────────────────
  const handleContainerPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      // Only respond to primary mouse button / touch / pen.
      if (e.button !== 0) return;
      if (isInteractiveTarget(e.target)) return;
      const container = parentRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const additive = e.shiftKey || e.metaKey || e.ctrlKey;
      pendingRef.current = {
        startClientX: e.clientX,
        startClientY: e.clientY,
        startContainerY: e.clientY - rect.top + container.scrollTop,
        startScrollTop: container.scrollTop,
        additive,
        baselineSelection: new Set(selectedTrackIds),
        active: false,
        pointerId: e.pointerId,
      };
      visibleAtPressRef.current = visibleIdsRef.current.slice();
      // Don't preventDefault — we still want the row's onClick to fire if
      // the user releases without moving.
    },
    [selectedTrackIds],
  );

  useEffect(() => {
    function pointerMove(e: PointerEvent) {
      const pending = pendingRef.current;
      if (!pending || pending.pointerId !== e.pointerId) return;
      const container = parentRef.current;
      if (!container) return;
      const dx = e.clientX - pending.startClientX;
      const dy = e.clientY - pending.startClientY;
      if (
        !pending.active &&
        Math.hypot(dx, dy) < RUBBERBAND_THRESHOLD_PX
      ) {
        return;
      }
      pending.active = true;

      const rect = container.getBoundingClientRect();
      const currContainerY = e.clientY - rect.top + container.scrollTop;
      const minY = Math.min(pending.startContainerY, currContainerY);
      const maxY = Math.max(pending.startContainerY, currContainerY);
      const totalRows = visibleAtPressRef.current.length;
      if (totalRows === 0) return;

      const firstIdx = Math.max(0, Math.floor(minY / ROW_HEIGHT_PX));
      const lastIdx = Math.min(
        totalRows - 1,
        Math.floor((maxY - 0.01) / ROW_HEIGHT_PX),
      );

      const ids = new Set<string>();
      if (pending.additive) {
        for (const id of pending.baselineSelection) ids.add(id);
      }
      if (firstIdx <= lastIdx) {
        for (let i = firstIdx; i <= lastIdx; i++) {
          const id = visibleAtPressRef.current[i];
          if (id) ids.add(id);
        }
      }
      // Apply selection; we don't move the anchor while rubber-banding.
      setSelection(ids);

      // Render rectangle in viewport coords (fixed-positioned overlay).
      const left = Math.min(pending.startClientX, e.clientX);
      const top = Math.min(pending.startClientY, e.clientY);
      const width = Math.abs(e.clientX - pending.startClientX);
      const height = Math.abs(e.clientY - pending.startClientY);
      setRubberbandRect({ left, top, width, height });
    }

    function pointerUp(e: PointerEvent) {
      const pending = pendingRef.current;
      if (!pending || pending.pointerId !== e.pointerId) return;
      const wasActive = pending.active;
      pendingRef.current = null;
      if (wasActive) {
        // We treated this as a drag; suppress the synthetic click that the
        // browser is about to fire on the press-down target.
        suppressClickRef.current = true;
        // Reset suppression on the next macrotask in case no click fires.
        window.setTimeout(() => {
          suppressClickRef.current = false;
        }, 0);
      }
      setRubberbandRect(null);
    }

    function pointerCancel(e: PointerEvent) {
      const pending = pendingRef.current;
      if (!pending || pending.pointerId !== e.pointerId) return;
      pendingRef.current = null;
      setRubberbandRect(null);
    }

    window.addEventListener("pointermove", pointerMove);
    window.addEventListener("pointerup", pointerUp);
    window.addEventListener("pointercancel", pointerCancel);
    return () => {
      window.removeEventListener("pointermove", pointerMove);
      window.removeEventListener("pointerup", pointerUp);
      window.removeEventListener("pointercancel", pointerCancel);
    };
  }, [setSelection]);

  // ─── DnD-kit drag wiring ────────────────────────────────────────────────
  // Live preview of the visible-id order while a multi-row drag is in
  // flight. `null` means "no preview — render `visibleTrackIds` directly"
  // (single-row drags fall back to dnd-kit's built-in row-shift animation,
  // which already does the right thing). When set, the SortableContext +
  // virtualizer render this order instead, so unselected rows visibly slide
  // out of the way and the non-active selected rows visibly slot into their
  // landing positions before the user releases. On drop, the same algorithm
  // (`moveSelectionMaintainingShape`) produces the final order — what the
  // user sees is what they get.
  const [dragPreviewIds, setDragPreviewIds] = useState<string[] | null>(null);
  // Set true for the duration of a multi-row drag. Lets non-active selected
  // rows render the same "lifting" opacity that dnd-kit applies to the
  // active row, so all rows in the moving block read as a single group.
  const [multiDragActive, setMultiDragActive] = useState(false);
  // dnd-kit's `over.id` can settle on a selected row while the preview is
  // shifting things around (a non-active selected row slides under the
  // cursor's screen position). The drop semantics treat "over a selected
  // row" as a no-op, which would silently abort the move the user just
  // built up visually. To avoid that, we remember the most recent UNSELECTED
  // over-id we saw during the drag and use it on release as a fallback
  // anchor when the final over-id is on a selected row. Cleared at drag
  // start/cancel.
  const lastUnselectedOverIdRef = useRef<string | null>(null);
  // The active drag id, captured at drag start so that handleDragOver can
  // pass it into the new algorithm without depending on dnd-kit's event
  // re-firing semantics. Cleared on end/cancel.
  const activeDragIdRef = useRef<string | null>(null);

  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      const activeId = String(event.active.id);
      activeDragIdRef.current = activeId;
      lastUnselectedOverIdRef.current = null;
      // If the dragged row isn't part of the current selection, the drag
      // should affect only that row. Make this visible by replacing the
      // selection so the user sees what they're carrying.
      if (!selectedTrackIds.has(activeId)) {
        selectOnly(activeId);
        setMultiDragActive(false);
        return;
      }
      setMultiDragActive(selectedTrackIds.size > 1);
    },
    [selectedTrackIds, selectOnly],
  );

  const handleDragOver = useCallback(
    (event: DragOverEvent) => {
      const { active, over } = event;
      if (!over) return;
      const activeId = String(active.id);
      const overId = String(over.id);
      const selection = usePlaylistStore.getState().selectedTrackIds;
      // Only multi-row drags need a preview override — dnd-kit handles the
      // single-row case natively.
      if (selection.size <= 1 || !selection.has(activeId)) {
        if (dragPreviewIds !== null) setDragPreviewIds(null);
        return;
      }
      // Hovering over a selected row keeps the last preview as-is (the live
      // reorder can scoot a selected row under the cursor mid-drag, but the
      // user's intent hasn't moved — keep showing the last valid landing).
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

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      const lastUnselectedOver = lastUnselectedOverIdRef.current;
      setDragPreviewIds(null);
      setMultiDragActive(false);
      activeDragIdRef.current = null;
      lastUnselectedOverIdRef.current = null;
      if (!over) return;
      const activeId = String(active.id);
      const overFromEvent = String(over.id);

      // After handleDragStart, the selection always contains activeId. So
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
        // Map the new visible-list order back into the full track-id list,
        // preserving hidden rows (filtered by Hide-unmatched) at their
        // original positions.
        const visibleSet = new Set(visibleTrackIds);
        let cursor = 0;
        const newAll = allTrackIds.map((id) =>
          visibleSet.has(id) ? newVisibleOrder[cursor++] : id,
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
        visibleSet.has(id) ? newVisibleOrder[cursor++] : id,
      );
      reorderTracks(newAll);
    },
    [allTrackIds, visibleTrackIds, reorderTracks],
  );

  const handleDragCancel = useCallback(() => {
    setDragPreviewIds(null);
    setMultiDragActive(false);
    activeDragIdRef.current = null;
    lastUnselectedOverIdRef.current = null;
  }, []);

  // Render order: the live drag preview when present, else the canonical
  // visible-id order. Always the same length, so the virtualizer's `count`
  // stays in sync.
  const orderedIds = dragPreviewIds ?? visibleTrackIds;
  const orderedTracks = useMemo<Track[]>(
    () => orderedIds.map((id) => tracksById[id]).filter(Boolean),
    [orderedIds, tracksById],
  );

  const selectedCount = selectedTrackIds.size;

  return (
    <div
      className="flex min-h-0 flex-1 select-none flex-col"
      role="grid"
      aria-label="Playlist tracks"
      aria-rowcount={visibleTrackIds.length + 1}
    >
      <div
        role="row"
        aria-rowindex={1}
        className="flex items-center border-b border-neutral-800 bg-neutral-900 px-2 text-xs font-semibold uppercase tracking-wide text-neutral-400"
      >
        <div role="columnheader" aria-hidden className="w-6" />
        <div role="columnheader" aria-hidden className="w-8" />
        {HEADERS.map((header) => (
          <Fragment key={header.field}>
            <div
              role="columnheader"
              aria-sort={
                sort?.field === header.field
                  ? sort.dir === "asc"
                    ? "ascending"
                    : "descending"
                  : "none"
              }
              className={`${header.width} px-2 py-2 text-left`}
            >
              <button
                type="button"
                onClick={() => setSort(header.field)}
                className="hover:text-neutral-200"
                aria-label={`Sort by ${header.label}`}
              >
                {header.label} {indicatorFor(header.field, sort?.field, sort?.dir)}
              </button>
            </div>
            {header.field === "index" && (
              <div role="columnheader" aria-hidden className="w-8" title="Cover" />
            )}
          </Fragment>
        ))}
        <div
          role="columnheader"
          className="w-10 px-2 py-2 text-left"
          title="MusicBrainz enrichment status"
        >
          MB
        </div>
        <div
          role="columnheader"
          className="w-10 px-2 py-2 text-left"
          title="Spotify match status"
        >
          <span aria-label="Spotify match status">♫</span>
        </div>
        <div role="columnheader" aria-hidden className="w-8" />
        <div role="columnheader" aria-hidden className="w-8" />
        {selectedCount > 0 && (
          <div className="ml-auto flex items-center gap-1">
            {selectedCount > 1 && (
              <span
                className="text-[11px] font-medium normal-case tracking-normal text-matched"
                aria-live="polite"
              >
                {selectedCount} selected
              </span>
            )}
            <IconButton
              label={
                selectedCount > 1
                  ? `Delete ${selectedCount} selected tracks`
                  : "Delete selected track"
              }
              icon={<TrashIcon />}
              onClick={deleteSelectionWithConfirm}
            />
          </div>
        )}
      </div>

      <div
        ref={parentRef}
        role="rowgroup"
        className="relative flex-1 overflow-auto"
        onPointerDown={handleContainerPointerDown}
      >
        <DndContext
          sensors={sensors}
          onDragStart={handleDragStart}
          onDragOver={handleDragOver}
          onDragEnd={handleDragEnd}
          onDragCancel={handleDragCancel}
        >
          <SortableContext
            items={orderedIds}
            strategy={verticalListSortingStrategy}
          >
            <div
              style={{
                height: `${rowVirtualizer.getTotalSize()}px`,
                position: "relative",
              }}
            >
              {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                const track = orderedTracks[virtualRow.index];
                if (!track) return null;
                const isSelected = selectedTrackIds.has(track.id);
                const nextTrack = orderedTracks[virtualRow.index + 1];
                const nextSelected = nextTrack
                  ? selectedTrackIds.has(nextTrack.id)
                  : false;
                return (
                  <div
                    key={track.id}
                    style={{
                      position: "absolute",
                      top: 0,
                      left: 0,
                      right: 0,
                      transform: `translateY(${virtualRow.start}px)`,
                      height: `${ROW_HEIGHT_PX}px`,
                    }}
                  >
                    <SortableTrackRow
                      track={track}
                      displayIndex={virtualRow.index + 1}
                      ariaRowIndex={virtualRow.index + 2}
                      selected={isSelected}
                      nextSelected={nextSelected}
                      partOfActiveMultiDrag={multiDragActive && isSelected}
                      onRowClick={handleRowClick}
                      onPickSpotifyMatch={onPickSpotifyMatch}
                      onPickEnrichmentMatch={onPickEnrichmentMatch}
                      onReEnrich={onReEnrich}
                      onRemove={handleRowRemove}
                    />
                  </div>
                );
              })}
            </div>
          </SortableContext>
        </DndContext>
      </div>

      {rubberbandRect && (
        <div
          aria-hidden
          className="pointer-events-none fixed z-50 rounded-sm border border-matched/60 bg-matched/15"
          style={{
            left: `${rubberbandRect.left}px`,
            top: `${rubberbandRect.top}px`,
            width: `${rubberbandRect.width}px`,
            height: `${rubberbandRect.height}px`,
          }}
        />
      )}

      <ConfirmDialog
        open={pendingDeleteIds !== null}
        title="Remove tracks?"
        message={
          pendingDeleteIds ? bulkDeleteMessage(pendingDeleteIds.length) : ""
        }
        confirmLabel="Remove"
        kind="danger"
        onConfirm={confirmPendingDelete}
        onCancel={() => setPendingDeleteIds(null)}
      />
    </div>
  );
}
