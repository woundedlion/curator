// @vitest-environment happy-dom
//
// Grid-semantics + managed-focus coverage for SortableTrackRow (findings
// 1 & 2). Asserts:
//   - every data cell carries role="gridcell" (the row's div cells were
//     previously plain divs, breaking the role="grid"/role="row" tree);
//   - the row exposes the stable id the grid container points
//     aria-activedescendant at, and is NOT itself a tab stop (focus is
//     managed on the container);
//   - the cursor row paints the same seamless green selection highlight as
//     a selected row (no focus ring/box border) — the cursor is conveyed to
//     assistive tech via the container's aria-activedescendant, not a border.
//
// The row uses dnd-kit's useSortable, so it must render inside a
// DndContext + SortableContext.

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { DndContext } from "@dnd-kit/core";
import { SortableContext } from "@dnd-kit/sortable";
import { SortableTrackRow } from "./SortableTrackRow";
import { rowDomId } from "./playlistRowId";
import type { Track } from "../types";

afterEach(cleanup);

function track(id: string): Track {
  return {
    id,
    source: { kind: "file", fileName: `${id}.mp3` },
    title: "Title",
    artist: "Artist",
    album: "Album",
    enrichment: { status: "idle" },
    spotify: { status: "idle" },
  } as unknown as Track;
}

function renderRow(overrides: Partial<Parameters<typeof SortableTrackRow>[0]> = {}) {
  const t = track("t1");
  const props = {
    track: t,
    rowId: rowDomId(t.id),
    displayIndex: 1,
    ariaRowIndex: 2,
    selected: false,
    isCursor: false,
    nextSelected: false,
    partOfActiveMultiDrag: false,
    multiDragActive: false,
    onRowClick: () => {},
    onPickSpotifyMatch: () => {},
    onPickEnrichmentMatch: () => {},
    onReEnrich: () => {},
    onRemove: () => {},
    ...overrides,
  };
  return render(
    <DndContext>
      <SortableContext items={[props.track.id]}>
        <SortableTrackRow {...props} />
      </SortableContext>
    </DndContext>,
  );
}

describe("SortableTrackRow — grid semantics", () => {
  it("marks every cell as a gridcell", () => {
    renderRow();
    const row = screen.getByRole("row");
    // Drag-handle, play, index, cover, artist, title, year, orig,
    // album, track#, MB, Spotify, re-enrich, remove = 14 cells.
    const cells = within(row).getAllByRole("gridcell");
    expect(cells.length).toBe(14);
  });

  it("exposes the stable activedescendant id and is not a tab stop", () => {
    renderRow();
    const row = screen.getByRole("row");
    expect(row.id).toBe(rowDomId("t1"));
    expect(row.getAttribute("tabindex")).toBe("-1");
  });

  it("highlights the cursor row with the seamless green selection background and no focus ring", () => {
    const { rerender } = renderRow({ isCursor: true });
    let row = screen.getByRole("row");
    // Cursor row gets the same highlight as a selected row, never a ring.
    expect(row.className).toContain("bg-matched/10");
    expect(row.className).not.toContain("ring-2");

    rerender(
      <DndContext>
        <SortableContext items={["t1"]}>
          <SortableTrackRow
            track={track("t1")}
            rowId={rowDomId("t1")}
            displayIndex={1}
            ariaRowIndex={2}
            selected={false}
            isCursor={false}
            nextSelected={false}
            partOfActiveMultiDrag={false}
            multiDragActive={false}
            onRowClick={() => {}}
            onPickSpotifyMatch={() => {}}
            onPickEnrichmentMatch={() => {}}
            onReEnrich={() => {}}
            onRemove={() => {}}
          />
        </SortableContext>
      </DndContext>,
    );
    row = screen.getByRole("row");
    // A row that is neither selected nor the cursor has no highlight.
    expect(row.className).not.toContain("bg-matched/10");
    expect(row.className).not.toContain("ring-2");
  });

  it("reflects selection via aria-selected", () => {
    renderRow({ selected: true });
    expect(screen.getByRole("row").getAttribute("aria-selected")).toBe("true");
  });
});
