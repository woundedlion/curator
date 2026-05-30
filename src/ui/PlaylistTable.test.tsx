// @vitest-environment happy-dom
//
// PlaylistTable previously had no tests. Its row rendering is virtualized
// (happy-dom computes no layout, so the virtualizer renders no rows), so
// these tests target the deterministic, non-virtualized surface:
//   - grid semantics: role, aria-rowcount, managed-focus aria-activedescendant
//   - the bulk-delete confirm gating reachable via the header's
//     Delete-selected button (≥2 selected → confirm; exactly 1 → immediate)
// The real playlist store drives selection; removeTracks is swapped for a
// spy so we assert intent without mutating.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("../db/draftRepository", () => ({
  saveDraft: vi.fn(async () => undefined),
  loadDraft: vi.fn(async () => ({ playlist: null, tracks: [] })),
}));
vi.mock("../services/cancelTrackRequests", () => ({
  cancelTrackRequests: vi.fn(),
}));

import { PlaylistTable } from "./PlaylistTable";
import { usePlaylistStore } from "../store/playlistStore";
import { rowDomId } from "./playlistRowId";
import type { Track } from "../types";

function track(id: string): Track {
  return {
    id,
    source: { kind: "file", fileName: `${id}.mp3` },
    title: id,
    artist: "A",
    enrichment: { status: "idle" },
    spotify: { status: "idle" },
  } as unknown as Track;
}

function seed(ids: string[]): void {
  const tracksById: Record<string, Track> = {};
  for (const id of ids) tracksById[id] = track(id);
  usePlaylistStore.setState({
    tracksById,
    playlist: { ...usePlaylistStore.getState().playlist, trackIds: ids, sort: null },
    selectedTrackIds: new Set<string>(),
    selectionAnchorId: null,
    undoStack: [],
  });
}

function renderTable(visibleTrackIds: string[]) {
  return render(
    <PlaylistTable
      visibleTrackIds={visibleTrackIds}
      onPickSpotifyMatch={() => {}}
      onPickEnrichmentMatch={() => {}}
      onReEnrich={() => {}}
    />,
  );
}

beforeEach(() => {
  seed([]);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("PlaylistTable — grid semantics", () => {
  it("aria-rowcount is the visible row count plus the header row", () => {
    seed(["a", "b", "c"]);
    renderTable(["a", "b", "c"]);
    const grid = screen.getByRole("grid", { name: "Playlist tracks" });
    expect(grid.getAttribute("aria-rowcount")).toBe("4");
  });

  it("points aria-activedescendant at the cursor row when it is visible", () => {
    seed(["a", "b", "c"]);
    usePlaylistStore.setState({ selectionAnchorId: "b" });
    renderTable(["a", "b", "c"]);
    const grid = screen.getByRole("grid", { name: "Playlist tracks" });
    expect(grid.getAttribute("aria-activedescendant")).toBe(rowDomId("b"));
  });

  it("clears aria-activedescendant when the cursor row is filtered out of view", () => {
    seed(["a", "b", "c"]);
    // Anchor on a row that is NOT in the visible set (e.g. hidden by a filter).
    usePlaylistStore.setState({ selectionAnchorId: "b" });
    renderTable(["a", "c"]);
    const grid = screen.getByRole("grid", { name: "Playlist tracks" });
    expect(grid.getAttribute("aria-activedescendant")).toBeNull();
  });
});

describe("PlaylistTable — bulk delete confirm gating", () => {
  it("≥2 selected: header delete opens a confirm; removeTracks fires only on confirm", () => {
    seed(["a", "b", "c"]);
    const removeTracks = vi.fn();
    usePlaylistStore.setState({
      removeTracks,
      selectedTrackIds: new Set(["a", "b"]),
      selectionAnchorId: "a",
    });
    renderTable(["a", "b", "c"]);

    fireEvent.click(
      screen.getByRole("button", { name: "Delete 2 selected tracks" }),
    );
    // Confirm dialog up, nothing deleted yet.
    expect(removeTracks).not.toHaveBeenCalled();
    expect(screen.getByText("Remove tracks?")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(removeTracks).toHaveBeenCalledTimes(1);
    expect(removeTracks.mock.calls[0]![0]).toEqual(["a", "b"]);
  });

  it("cancelling the bulk-delete confirm leaves the selection intact", () => {
    seed(["a", "b", "c"]);
    const removeTracks = vi.fn();
    usePlaylistStore.setState({
      removeTracks,
      selectedTrackIds: new Set(["a", "b"]),
      selectionAnchorId: "a",
    });
    renderTable(["a", "b", "c"]);

    fireEvent.click(
      screen.getByRole("button", { name: "Delete 2 selected tracks" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(removeTracks).not.toHaveBeenCalled();
    expect(screen.queryByText("Remove tracks?")).toBeNull();
  });

  it("exactly 1 selected: header delete removes immediately with no confirm", () => {
    seed(["a", "b", "c"]);
    const removeTracks = vi.fn();
    usePlaylistStore.setState({
      removeTracks,
      selectedTrackIds: new Set(["b"]),
      selectionAnchorId: "b",
    });
    renderTable(["a", "b", "c"]);

    fireEvent.click(
      screen.getByRole("button", { name: "Delete selected track" }),
    );
    expect(screen.queryByText("Remove tracks?")).toBeNull();
    expect(removeTracks).toHaveBeenCalledTimes(1);
    expect(removeTracks.mock.calls[0]![0]).toEqual(["b"]);
  });
});
