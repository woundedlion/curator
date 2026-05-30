import { Fragment } from "react";
import { IconButton } from "./IconButton";
import { TrashIcon } from "./icons";
import type { SortField, SortSpec } from "../types";

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

type Props = {
  sort: SortSpec;
  onSetSort: (field: SortField) => void;
  selectedCount: number;
  onDeleteSelection: () => void;
};

export function PlaylistTableHeader({
  sort,
  onSetSort,
  selectedCount,
  onDeleteSelection,
}: Props) {
  return (
    <div
      role="row"
      aria-rowindex={1}
      className="flex items-center border-b border-neutral-800 bg-neutral-900 px-2 text-xs font-semibold uppercase tracking-wide text-neutral-400"
    >
      {/* Purely decorative spacer columns (drag handle, play button,
          cover, action buttons). They carry no label, so a columnheader
          role would announce an empty header — and pairing that role
          with aria-hidden was self-contradictory (role says "I'm a
          header", aria-hidden says "ignore me"). Plain aria-hidden divs
          take them out of the grid's column-header set entirely, which
          is what they are. */}
      <div aria-hidden className="w-6" />
      <div aria-hidden className="w-8" />
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
              onClick={() => onSetSort(header.field)}
              className="hover:text-neutral-200"
              aria-label={`Sort by ${header.label}`}
            >
              {header.label} {indicatorFor(header.field, sort?.field, sort?.dir)}
            </button>
          </div>
          {header.field === "index" && (
            <div aria-hidden className="w-8" title="Cover" />
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
      <div aria-hidden className="w-8" />
      <div aria-hidden className="w-8" />
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
            onClick={onDeleteSelection}
          />
        </div>
      )}
    </div>
  );
}
