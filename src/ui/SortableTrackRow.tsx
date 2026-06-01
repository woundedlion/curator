import { memo, useCallback, type MouseEvent } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { Track } from "../types";
import { formatDuration } from "../util/duration";
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
  // Stable DOM id (rowDomId(track.id)) so the grid container's
  // aria-activedescendant can resolve to this row when it's the cursor.
  rowId: string;
  displayIndex: number;
  selected: boolean;
  // True iff this row holds the keyboard cursor (the grid's active
  // descendant). Renders the same seamless green highlight as a selected
  // row (no focus ring) — DOM focus stays on the container, and the cursor
  // is exposed to assistive tech via aria-activedescendant, not a border.
  isCursor: boolean;
  // True when the row immediately below is also selected. When set, the
  // row drops its bottom divider so a multi-row selection reads as one
  // continuous tinted block instead of N separately-bordered rows.
  nextSelected: boolean;
  // True iff this row belongs to a multi-row selection that is currently
  // being dragged (any row in that selection acts as "active" to dnd-kit,
  // the others ride along via the preview reorder). Applies the same
  // "lifting" opacity that dnd-kit gives the active row so the whole moving
  // block reads as one group rather than the active row leaving the others
  // behind looking unchanged.
  partOfActiveMultiDrag: boolean;
  // True for EVERY row (selected or not) while a multi-row drag is in
  // flight. During such a drag the table re-renders in the live preview
  // order, so the virtualizer already places each row in its landing slot.
  // dnd-kit's verticalListSortingStrategy would ALSO transform rows to make
  // room for the active item — double-positioning that visually tears the
  // moving block apart. We suppress the per-row transform so the preview
  // order is the sole positioner. (Single-row drags leave this false and
  // keep dnd-kit's native row-shift animation, which already works.)
  multiDragActive: boolean;
  // Row position in the visible list (1-based). Surfaced as aria-rowindex
  // so screen readers can announce row N of M during navigation; offset by
  // +1 to account for the column-header row.
  ariaRowIndex: number;
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
  rowId,
  displayIndex,
  selected,
  isCursor,
  nextSelected,
  partOfActiveMultiDrag,
  multiDragActive,
  ariaRowIndex,
  onRowClick,
  onPickSpotifyMatch,
  onPickEnrichmentMatch,
  onReEnrich,
  onRemove,
}: Props) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: track.id });

  // During a multi-row drag the preview reorder (rendered by the
  // virtualizer) already positions every row at its landing slot, so
  // dnd-kit's strategy transform must be dropped to avoid double-movement
  // that separates the dragged block. See `multiDragActive` in Props.
  const style: React.CSSProperties = {
    transform: multiDragActive ? undefined : CSS.Transform.toString(transform),
    transition: multiDragActive ? undefined : transition,
    opacity: isDragging || partOfActiveMultiDrag ? 0.6 : 1,
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

  // NOTE: rows deliberately have NO onKeyDown handler. They are
  // tabIndex=-1 (never a tab stop) and virtualize, so DOM focus lives on
  // the grid container, not the row. Keyboard activation of the cursor
  // row (Space/Enter toggles selection) is handled centrally by the
  // container's nav hook (useTableKeyboardNav) against the cursor row.
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
  // without competing with the data inside the row. The keyboard cursor
  // (active-descendant) row gets the *same* seamless highlight rather than
  // a focus ring/box border — DOM focus lives on the grid container, so
  // there is no :focus styling to land here; the cursor position is
  // conveyed to assistive tech via aria-activedescendant (see
  // PlaylistTable), not a visible border. When the next row is also part
  // of the highlight we drop the bottom divider so the block reads as one
  // continuous tinted area.
  const highlighted = selected || isCursor;
  const selectionClasses = highlighted
    ? "bg-matched/10 border-l-2 border-l-matched"
    : "border-l-2 border-l-transparent";
  const dividerClass =
    highlighted && nextSelected ? "" : "border-b border-neutral-900";

  return (
    <div
      ref={setNodeRef}
      id={rowId}
      style={style}
      onClick={handleClick}
      role="row"
      // Focus is managed at the grid container via aria-activedescendant
      // (rows virtualize and can unmount), so individual rows are never
      // tab stops.
      tabIndex={-1}
      aria-rowindex={ariaRowIndex}
      aria-selected={selected}
      className={`flex h-full items-center ${dividerClass} px-2 text-sm ${selectionClasses} ${
        isMuted ? "text-neutral-500" : "text-neutral-100"
      } focus:outline-none`}
      data-track-id={track.id}
    >
      {/* role="gridcell" on every cell so the role="grid" / role="row"
          ancestors have valid grid children — AT can now report "row N,
          column M" and navigate cells. The drag handle's own cell wraps
          the button (a gridcell must be the row's child, the button the
          gridcell's child). Layout is unchanged: the wrapper carries the
          width class the button previously held. */}
      <div role="gridcell" className="w-6">
        <button
          type="button"
          {...attributes}
          {...listeners}
          className="cursor-grab text-neutral-500 hover:text-neutral-300"
          aria-label="Drag to reorder (Space to lift, arrows to move, Space to drop)"
          aria-keyshortcuts="Space ArrowUp ArrowDown"
          title="Drag to reorder"
        >
          ⋮⋮
        </button>
      </div>
      <div role="gridcell" className="w-8 px-1">
        <PlayButton track={track} />
      </div>
      <div role="gridcell" className="w-12 px-2 tabular-nums text-neutral-400">
        {displayIndex}
      </div>
      <div role="gridcell" className="flex w-8 items-center justify-center">
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
      <div role="gridcell" className="w-48 truncate px-2">
        {renderCell(track.artist)}
      </div>
      <div
        role="gridcell"
        className="flex min-w-0 flex-1 items-baseline gap-2 px-2"
      >
        <span className="min-w-0 truncate">{renderCell(track.title)}</span>
        {track.durationMs !== undefined && (
          <span className="shrink-0 tabular-nums text-xs text-neutral-500">
            {formatDuration(track.durationMs)}
          </span>
        )}
      </div>
      <div role="gridcell" className="w-16 px-2 tabular-nums">
        {renderCell(track.year)}
      </div>
      <div role="gridcell" className="w-16 px-2 tabular-nums text-neutral-400">
        {renderCell(track.originalYear)}
      </div>
      <div role="gridcell" className="w-56 truncate px-2">
        {renderCell(track.album)}
      </div>
      <div role="gridcell" className="w-12 px-2 tabular-nums">
        {formatTrackNumber(track)}
      </div>
      <div role="gridcell" className="w-10 px-2">
        <EnrichmentGlyph
          status={track.enrichment.status}
          onPick={handlePickEnrichment}
        />
      </div>
      <div role="gridcell" className="w-10 px-2">
        <StatusGlyph
          status={track.spotify.status}
          onPick={handlePickSpotify}
        />
      </div>
      <div role="gridcell" className="w-8 px-1">
        <button
          type="button"
          onClick={handleReEnrich}
          aria-label="Re-search Spotify and re-enrich from MusicBrainz"
          title="Re-search Spotify and re-enrich from MusicBrainz"
          className="inline-flex items-center justify-center bg-transparent px-1 py-0.5 text-sm text-matched transition-opacity hover:opacity-70"
        >
          ↻
        </button>
      </div>
      <div role="gridcell" className="w-8 px-1">
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
