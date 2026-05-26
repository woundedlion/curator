import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { Track } from "../types";
import { EnrichmentGlyph } from "./EnrichmentGlyph";
import { TrashIcon } from "./icons";
import { PlayButton } from "./PlayButton";
import { StatusGlyph } from "./StatusGlyph";

type Props = {
  track: Track;
  displayIndex: number;
  onPickSpotifyMatch: () => void;
  onPickEnrichmentMatch: () => void;
  onReEnrich: () => void;
  onRemove: () => void;
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

export function SortableTrackRow({
  track,
  displayIndex,
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

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`flex items-center border-b border-neutral-900 px-2 text-sm ${
        isMuted ? "text-neutral-500" : "text-neutral-100"
      }`}
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
          onPick={onPickEnrichmentMatch}
        />
      </div>
      <div className="w-10 px-2">
        <StatusGlyph
          status={track.spotify.status}
          onPick={onPickSpotifyMatch}
        />
      </div>
      <div className="w-8 px-1">
        <button
          type="button"
          onClick={onReEnrich}
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
          onClick={onRemove}
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
