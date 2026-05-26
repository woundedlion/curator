import { Fragment, useCallback, useMemo, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  DndContext,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { ROW_HEIGHT_PX } from "../constants";
import { usePlaylistStore } from "../store/playlistStore";
import type { SortField, Track } from "../types";
import { SortableTrackRow } from "./SortableTrackRow";

type Props = {
  visibleTrackIds: string[];
  onPickSpotifyMatch: (trackId: string) => void;
  onPickEnrichmentMatch: (trackId: string) => void;
  onReEnrich: (trackId: string) => void;
  onRemove: (trackId: string) => void;
};

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

export function PlaylistTable({
  visibleTrackIds,
  onPickSpotifyMatch,
  onPickEnrichmentMatch,
  onReEnrich,
  onRemove,
}: Props) {
  const tracksById = usePlaylistStore((state) => state.tracksById);
  const sort = usePlaylistStore((state) => state.playlist.sort);
  const setSort = usePlaylistStore((state) => state.setSort);
  const reorderTracks = usePlaylistStore((state) => state.reorderTracks);
  const allTrackIds = usePlaylistStore((state) => state.playlist.trackIds);

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

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const oldIndex = allTrackIds.indexOf(String(active.id));
      const newIndex = allTrackIds.indexOf(String(over.id));
      if (oldIndex === -1 || newIndex === -1) return;
      reorderTracks(arrayMove(allTrackIds, oldIndex, newIndex));
    },
    [allTrackIds, reorderTracks],
  );

  const visibleTracks = useMemo<Track[]>(
    () => visibleTrackIds.map((id) => tracksById[id]).filter(Boolean),
    [visibleTrackIds, tracksById],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex border-b border-neutral-800 bg-neutral-900 px-2 text-xs font-semibold uppercase tracking-wide text-neutral-400">
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
      </div>

      <div ref={parentRef} className="flex-1 overflow-auto">
        <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
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
                      onPickSpotifyMatch={() => onPickSpotifyMatch(track.id)}
                      onPickEnrichmentMatch={() =>
                        onPickEnrichmentMatch(track.id)
                      }
                      onReEnrich={() => onReEnrich(track.id)}
                      onRemove={() => onRemove(track.id)}
                    />
                  </div>
                );
              })}
            </div>
          </SortableContext>
        </DndContext>
      </div>
    </div>
  );
}
