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

// Shared confirm prompt used by the header Delete button, the Delete key,
// and the per-row trash icon when the clicked row is part of a multi-
// selection. Kept module-level so the wording stays consistent regardless
// of entry point.
function confirmBulkDelete(count: number): boolean {
  return window.confirm(
    `Remove ${count} selected tracks? You can undo this while the tab is open.`,
  );
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
  const moveSelectionTo = usePlaylistStore((state) => state.moveSelectionTo);
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
    if (ids.length > 1 && !confirmBulkDelete(ids.length)) return;
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
        if (!confirmBulkDelete(selection.size)) return;
        removeTracks(Array.from(selection));
        return;
      }
      removeTracks([trackId]);
    },
    [removeTracks],
  );

  // ─── Keyboard: Delete = bulk remove, Esc = clear selection ───────────────
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const target = e.target;
      // Ignore when the user is typing into a field or content-editable area.
      if (target instanceof Element) {
        if (
          target.closest('input, textarea, select, [contenteditable="true"]')
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
  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      const activeId = String(event.active.id);
      // If the dragged row isn't part of the current selection, the drag
      // should affect only that row. Make this visible by replacing the
      // selection so the user sees what they're carrying.
      if (!selectedTrackIds.has(activeId)) {
        selectOnly(activeId);
      }
    },
    [selectedTrackIds, selectOnly],
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over) return;
      const activeId = String(active.id);
      const overId = String(over.id);

      // After handleDragStart, the selection always contains activeId. So
      // the "current selection" is the set we should move.
      const currentSelection = usePlaylistStore.getState().selectedTrackIds;

      if (currentSelection.size > 1) {
        if (currentSelection.has(overId)) return;
        moveSelectionTo(overId);
        return;
      }

      // Single-row drag falls through to the simple arrayMove path so the
      // existing semantics are preserved bit-for-bit.
      if (activeId === overId) return;
      const oldIndex = allTrackIds.indexOf(activeId);
      const newIndex = allTrackIds.indexOf(overId);
      if (oldIndex === -1 || newIndex === -1) return;
      reorderTracks(arrayMove(allTrackIds, oldIndex, newIndex));
    },
    [allTrackIds, reorderTracks, moveSelectionTo],
  );

  const visibleTracks = useMemo<Track[]>(
    () => visibleTrackIds.map((id) => tracksById[id]).filter(Boolean),
    [visibleTrackIds, tracksById],
  );

  const selectedCount = selectedTrackIds.size;

  return (
    <div className="flex min-h-0 flex-1 select-none flex-col">
      <div className="flex items-center border-b border-neutral-800 bg-neutral-900 px-2 text-xs font-semibold uppercase tracking-wide text-neutral-400">
        <div className="w-6" aria-hidden />
        <div className="w-8" aria-hidden />
        {HEADERS.map((header) => (
          <Fragment key={header.field}>
            <button
              type="button"
              onClick={() => setSort(header.field)}
              className={`${header.width} px-2 py-2 text-left hover:text-neutral-200`}
              aria-sort={
                sort?.field === header.field
                  ? sort.dir === "asc"
                    ? "ascending"
                    : "descending"
                  : "none"
              }
            >
              {header.label} {indicatorFor(header.field, sort?.field, sort?.dir)}
            </button>
            {header.field === "index" && (
              <div className="w-8" aria-hidden title="Cover" />
            )}
          </Fragment>
        ))}
        <div
          className="w-10 px-2 py-2 text-left"
          title="MusicBrainz enrichment status"
        >
          MB
        </div>
        <div className="w-10 px-2 py-2 text-left" title="Spotify match status">
          ♫
        </div>
        <div className="w-8" aria-hidden />
        <div className="w-8" aria-hidden />
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
        className="relative flex-1 overflow-auto"
        onPointerDown={handleContainerPointerDown}
      >
        <DndContext
          sensors={sensors}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={visibleTrackIds}
            strategy={verticalListSortingStrategy}
          >
            <div
              style={{
                height: `${rowVirtualizer.getTotalSize()}px`,
                position: "relative",
              }}
            >
              {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                const track = visibleTracks[virtualRow.index];
                if (!track) return null;
                const isSelected = selectedTrackIds.has(track.id);
                const nextTrack = visibleTracks[virtualRow.index + 1];
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
                      selected={isSelected}
                      nextSelected={nextSelected}
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
          className="pointer-events-none fixed z-40 rounded-sm border border-matched/60 bg-matched/15"
          style={{
            left: `${rubberbandRect.left}px`,
            top: `${rubberbandRect.top}px`,
            width: `${rubberbandRect.width}px`,
            height: `${rubberbandRect.height}px`,
          }}
        />
      )}
    </div>
  );
}
