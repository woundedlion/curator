// @vitest-environment happy-dom
//
// Header grid-semantics coverage (finding 1). The decorative spacer
// columns previously carried BOTH role="columnheader" AND aria-hidden —
// a contradiction (header says "announce me", aria-hidden says "ignore
// me"). The fix drops the role on purely-decorative spacers, leaving
// only the real, labelled columns as columnheaders.

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { PlaylistTableHeader } from "./PlaylistTableHeader";

afterEach(cleanup);

describe("PlaylistTableHeader — grid semantics", () => {
  it("exposes exactly the real labelled columns as columnheaders", () => {
    render(
      <PlaylistTableHeader
        sort={{ field: "artist", dir: "asc" }}
        onSetSort={() => {}}
        selectedCount={0}
        onDeleteSelection={() => {}}
      />,
    );
    // 7 sortable HEADERS + MB + Spotify = 9 columnheaders. The drag /
    // play / cover / action spacers are no longer columnheaders.
    const headers = screen.getAllByRole("columnheader");
    expect(headers.length).toBe(9);
  });

  it("reflects the active sort via aria-sort on the sorted column", () => {
    render(
      <PlaylistTableHeader
        sort={{ field: "artist", dir: "asc" }}
        onSetSort={() => {}}
        selectedCount={0}
        onDeleteSelection={() => {}}
      />,
    );
    const sorted = screen
      .getAllByRole("columnheader")
      .find((h) => h.getAttribute("aria-sort") === "ascending");
    expect(sorted).toBeTruthy();
  });

  it("the header row is row 1 of the grid", () => {
    render(
      <PlaylistTableHeader
        sort={{ field: "artist", dir: "asc" }}
        onSetSort={() => {}}
        selectedCount={0}
        onDeleteSelection={() => {}}
      />,
    );
    expect(screen.getByRole("row").getAttribute("aria-rowindex")).toBe("1");
  });
});
