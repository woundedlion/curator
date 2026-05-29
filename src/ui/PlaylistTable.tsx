import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { useShallow } from "zustand/react/shallow";
import { ROW_HEIGHT_PX } from "../constants";
import { usePlaylistStore } from "../store/playlistStore";
import { ConfirmDialog } from "./ConfirmDialog";
import { PlaylistTableHeader } from "./PlaylistTableHeader";
import { RubberbandOverlay } from "./RubberbandOverlay";
import type { RowClickModifiers } from "./SortableTrackRow";
import { SortableTrackRow } from "./SortableTrackRow";
import { usePlaylistDragAndDrop } from "./usePlaylistDragAndDrop";
import { useRubberbandSelection } from "./useRubberbandSelection";
import { useTableKeyboardNav } from "./useTableKeyboardNav";
import { useTableScrollRestoration } from "./useTableScrollRestoration";
import type { Track } from "../types";

type Props = {
  visibleTrackIds: string[];
  onPickSpotifyMatch: (trackId: string) => void;
  onPickEnrichmentMatch: (trackId: string) => void;
  onReEnrich: (trackId: string) => void;
};

function bulkDeleteMessage(count: number): string {
  return `Remove ${count} selected tracks? You can undo this while the tab is open.`;
}

export function PlaylistTable({
  visibleTrackIds,
  onPickSpotifyMatch,
  onPickEnrichmentMatch,
  onReEnrich,
}: Props) {
  // One shallow-equal subscription instead of ten separate ones — the
  // component still re-renders on any of these fields changing, but the
  // subscription set is centralized and trivially auditable.
  const {
    tracksById,
    sort,
    setSort,
    removeTracks,
    allTrackIds,
    selectedTrackIds,
    selectOnly,
    toggleSelection,
    extendSelectionTo,
    clearSelection,
  } = usePlaylistStore(
    useShallow((state) => ({
      tracksById: state.tracksById,
      sort: state.playlist.sort,
      setSort: state.setSort,
      removeTracks: state.removeTracks,
      allTrackIds: state.playlist.trackIds,
      selectedTrackIds: state.selectedTrackIds,
      selectOnly: state.selectOnly,
      toggleSelection: state.toggleSelection,
      extendSelectionTo: state.extendSelectionTo,
      clearSelection: state.clearSelection,
    })),
  );

  const parentRef = useRef<HTMLDivElement | null>(null);
  // Mirror visibleTrackIds into a ref synced via a commit-phase effect
  // so the row-click callback can read it without listing the array in
  // its useCallback deps. Without this, every status flip that mutates
  // visibleTrackIds (cover URL arrival, match resolution, etc.) busts
  // handleRowClick's identity, which in turn busts SortableTrackRow's
  // memo for every visible row — i.e. a full table reconciliation per
  // background update. Click events fire after commit, so the brief
  // render→commit window where the ref still points at the prior
  // value is unobservable in practice.
  const visibleIdsRef = useRef(visibleTrackIds);
  useEffect(() => {
    visibleIdsRef.current = visibleTrackIds;
  });
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

  useTableScrollRestoration(parentRef, visibleTrackIds.length);

  const { onContainerPointerDown, rubberbandRect, suppressClickRef } =
    useRubberbandSelection(parentRef, visibleTrackIds);

  const {
    onDragStart,
    onDragOver,
    onDragEnd,
    onDragCancel,
    dragPreviewIds,
    multiDragActive,
    activeDragTrackId,
    dragOverlayCount,
  } = usePlaylistDragAndDrop(visibleTrackIds, allTrackIds);

  // ─── Confirm-dialog state for destructive bulk deletes ───────────────────
  // `pendingDeleteIds` is the snapshot taken at the moment the user requested
  // the delete — the live selection may have shifted by the time the user
  // clicks Confirm, so we honor what they had selected when they pressed.
  const [pendingDeleteIds, setPendingDeleteIds] = useState<string[] | null>(
    null,
  );

  // Delete every currently-selected row. Confirms when ≥2 are selected so
  // an accidental press of Delete (or click of the header Delete button)
  // doesn't wipe a whole multi-selection. Bound by the live store state so
  // the same helper works for the keyboard handler, the header button, and
  // the per-row trash icon when the row belongs to the selection.
  const deleteSelectionWithConfirm = useCallback(() => {
    const ids = Array.from(usePlaylistStore.getState().selectedTrackIds);
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

  // Page size derives from current viewport height; recomputed per
  // keystroke so window resizing or sidebar toggles don't stale-cache.
  const getPageSize = useCallback(() => {
    const h = parentRef.current?.clientHeight ?? 0;
    return Math.max(1, Math.floor(h / ROW_HEIGHT_PX));
  }, []);

  const scrollToIndex = useCallback(
    (index: number) => {
      rowVirtualizer.scrollToIndex(index, { align: "auto" });
    },
    [rowVirtualizer],
  );

  useTableKeyboardNav({
    visibleTrackIds,
    getPageSize,
    scrollToIndex,
    onDeleteSelection: deleteSelectionWithConfirm,
  });

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
    [
      suppressClickRef,
      extendSelectionTo,
      toggleSelection,
      selectOnly,
      clearSelection,
    ],
  );

  // Render order: the live drag preview when present, else the canonical
  // visible-id order. Always the same length, so the virtualizer's `count`
  // stays in sync.
  const orderedIds = dragPreviewIds ?? visibleTrackIds;
  const orderedTracks = useMemo<Track[]>(
    () =>
      orderedIds
        .map((id) => tracksById[id])
        .filter((t): t is Track => t !== undefined),
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
      <PlaylistTableHeader
        sort={sort}
        onSetSort={setSort}
        selectedCount={selectedCount}
        onDeleteSelection={deleteSelectionWithConfirm}
      />

      <div
        ref={parentRef}
        role="rowgroup"
        className="relative flex-1 overflow-auto"
        onPointerDown={onContainerPointerDown}
      >
        <DndContext
          sensors={sensors}
          onDragStart={onDragStart}
          onDragOver={onDragOver}
          onDragEnd={onDragEnd}
          onDragCancel={onDragCancel}
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
          <DragOverlay dropAnimation={null}>
            {activeDragTrackId && tracksById[activeDragTrackId] ? (
              <DragPreviewCard
                track={tracksById[activeDragTrackId]!}
                count={dragOverlayCount}
              />
            ) : null}
          </DragOverlay>
        </DndContext>
      </div>

      <RubberbandOverlay rect={rubberbandRect} />

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

function DragPreviewCard({ track, count }: { track: Track; count: number }) {
  const artist = track.artist ?? "—";
  const title = track.title ?? "—";
  return (
    <div className="pointer-events-none flex items-center gap-2 rounded border border-neutral-700 bg-neutral-900/95 px-3 py-1.5 text-sm text-neutral-100 shadow-2xl">
      <span className="max-w-xs truncate">
        {artist} — {title}
      </span>
      {count > 1 && (
        <span className="ml-1 rounded-full bg-matched px-2 py-0.5 text-xs font-medium tabular-nums text-neutral-900">
          {count}
        </span>
      )}
    </div>
  );
}
