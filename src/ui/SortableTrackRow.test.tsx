// @vitest-environment happy-dom
//
// Grid-semantics + managed-focus coverage for SortableTrackRow (findings
// 1 & 2). Asserts:
//   - every data cell carries role="gridcell" (the row's div cells were
//     previously plain divs, breaking the role="grid"/role="row" tree);
//   - the row exposes the stable id the grid container points
//     aria-activedescendant at, and is NOT itself a tab stop (focus is
//     managed on the container);
//   - the cursor row paints a visible focus ring (the only cue, since DOM
//     focus lives on the container, not the row).
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

  it("paints a focus ring on the cursor row and not on others", () => {
    const { rerender } = renderRow({ isCursor: true });
    let row = screen.getByRole("row");
    expect(row.className).toContain("ring-2");

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
    expect(row.className).not.toContain("ring-2");
  });

  it("reflects selection via aria-selected", () => {
    renderRow({ selected: true });
    expect(screen.getByRole("row").getAttribute("aria-selected")).toBe("true");
  });
});
