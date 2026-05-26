import { memo, useCallback, type MouseEvent } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { Track } from "../types";
import { EnrichmentGlyph } from "./EnrichmentGlyph";
import { TrashIcon } from "./icons";
import { PlayButton } from "./PlayButton";
import { StatusGlyph } from "./StatusGlyph";

export type RowClickModifiers = {
  shift: boolean;
  // True for ctrl on Win/Linux, meta (cmd) on macOS — both used for toggle.
  meta: boolean;
};

type Props = {
  track: Track;
  displayIndex: number;
  selected: boolean;
  // True when the row immediately below is also selected. When set, the
  // row drops its bottom divider so a multi-row selection reads as one
  // continuous tinted block instead of N separately-bordered rows.
  nextSelected: boolean;
  onRowClick: (trackId: string, modifiers: RowClickModifiers) => void;
  onPickSpotifyMatch: (trackId: string) => void;
  onPickEnrichmentMatch: (trackId: string) => void;
  onReEnrich: (trackId: string) => void;
  onRemove: (trackId: string) => void;
};

function formatTrackNumber(track: Track): string {
  if (track.trackNo === undefined) return "—";
  if (track.trackOf === undefined) return String(track.trackNo);
  return `${track.trackNo}/${track.trackOf}`;
}

function renderCell(value: string | number | undefined): string {
  if (value === undefined || value === "") return "—";
  return String(value);
}

function SortableTrackRowImpl({
  track,
  displayIndex,
  selected,
  nextSelected,
  onRowClick,
  onPickSpotifyMatch,
  onPickEnrichmentMatch,
  onReEnrich,
  onRemove,
}: Props) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: track.id });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1,
  };

  const isMuted = track.spotify.status === "missing";

  const handleClick = useCallback(
    (e: MouseEvent<HTMLDivElement>) => {
      if (
        e.target instanceof Element &&
        e.target.closest('button, a, input, [role="button"]')
      ) {
        return;
      }
      onRowClick(track.id, {
        shift: e.shiftKey,
        meta: e.metaKey || e.ctrlKey,
      });
    },
    [onRowClick, track.id],
  );
  const handlePickSpotify = useCallback(
    () => onPickSpotifyMatch(track.id),
    [onPickSpotifyMatch, track.id],
  );
  const handlePickEnrichment = useCallback(
    () => onPickEnrichmentMatch(track.id),
    [onPickEnrichmentMatch, track.id],
  );
  const handleReEnrich = useCallback(
    () => onReEnrich(track.id),
    [onReEnrich, track.id],
  );
  const handleRemove = useCallback(
    () => onRemove(track.id),
    [onRemove, track.id],
  );

  // Selection background uses the Spotify-green tint at 10% alpha plus a
  // small left accent strip so a glance at the edge confirms multi-select
  // without competing with the data inside the row. When the next row is
  // also selected we drop the bottom divider so the block reads as one
  // continuous tinted area.
  const selectionClasses = selected
    ? "bg-matched/10 border-l-2 border-l-matched"
    : "border-l-2 border-l-transparent";
  const dividerClass =
    selected && nextSelected ? "" : "border-b border-neutral-900";

  return (
    <div
      ref={setNodeRef}
      style={style}
      onClick={handleClick}
      className={`flex h-full items-center ${dividerClass} px-2 text-sm ${selectionClasses} ${
        isMuted ? "text-neutral-500" : "text-neutral-100"
      }`}
      data-track-id={track.id}
      aria-selected={selected}
    >
      <button
        type="button"
        {...attributes}
        {...listeners}
        className="w-6 cursor-grab text-neutral-500 hover:text-neutral-300"
        aria-label="Drag to reorder"
        title="Drag to reorder"
      >
        ⋮⋮
      </button>
      <div className="w-8 px-1">
        <PlayButton track={track} />
      </div>
      <div className="w-12 px-2 tabular-nums text-neutral-400">
        {displayIndex}
      </div>
      <div className="flex w-8 items-center justify-center">
        {track.coverUrl ? (
          <img
            src={track.coverUrl}
            alt=""
            className="h-7 w-7 rounded object-cover"
            loading="lazy"
          />
        ) : (
          <div className="h-7 w-7 rounded bg-neutral-800/60" aria-hidden />
        )}
      </div>
      <div className="w-48 truncate px-2">{renderCell(track.artist)}</div>
      <div className="flex-1 truncate px-2">{renderCell(track.title)}</div>
      <div className="w-16 px-2 tabular-nums">{renderCell(track.year)}</div>
      <div className="w-16 px-2 tabular-nums text-neutral-400">
        {renderCell(track.originalYear)}
      </div>
      <div className="w-56 truncate px-2">{renderCell(track.album)}</div>
      <div className="w-12 px-2 tabular-nums">{formatTrackNumber(track)}</div>
      <div className="w-10 px-2">
        <EnrichmentGlyph
          status={track.enrichment.status}
          onPick={handlePickEnrichment}
        />
      </div>
      <div className="w-10 px-2">
        <StatusGlyph
          status={track.spotify.status}
          onPick={handlePickSpotify}
        />
      </div>
      <div className="w-8 px-1">
        <button
          type="button"
          onClick={handleReEnrich}
          aria-label="Re-enrich (clears cached MusicBrainz result)"
          title="Re-enrich (clears cached MusicBrainz result)"
          className="inline-flex items-center justify-center bg-transparent px-1 py-0.5 text-sm text-neutral-100 transition-opacity hover:opacity-70"
        >
          ↻
        </button>
      </div>
      <div className="w-8 px-1">
        <button
          type="button"
          onClick={handleRemove}
          aria-label="Remove track from playlist"
          title="Remove track from playlist"
          className="inline-flex items-center justify-center bg-transparent px-1 py-0.5 text-matched transition-opacity hover:opacity-80"
        >
          <TrashIcon />
        </button>
      </div>
    </div>
  );
}

export const SortableTrackRow = memo(SortableTrackRowImpl);
