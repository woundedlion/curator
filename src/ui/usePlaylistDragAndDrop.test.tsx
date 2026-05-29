// @vitest-environment happy-dom
//
// Tests for usePlaylistDragAndDrop — the hook that wires dnd-kit's
// drag-start/-over/-end events into the playlist store, handles both
// single-row and multi-row drags, computes the live drag preview for
// multi-row drags, and (the trickiest bit) falls back to the
// last-unselected over-id when dnd-kit's `over.id` settles on a
// selected row because the preview shifted things under the cursor.
//
// Behaviors locked in here:
//
//   1. onDragStart on a non-selected row: replaces the selection with
//      that single row; multiDragActive=false; dragOverlayCount=1.
//      Without the replace, dragging an unselected row would leave
//      the user staring at a 5-row drag overlay carrying just the
//      one row they grabbed.
//   2. onDragStart on a row that IS part of a multi-selection: keeps
//      the selection; multiDragActive=(size > 1); dragOverlayCount=
//      selection size.
//   3. onDragOver during a multi-row drag: computes a preview order
//      via moveSelectionMaintainingShape. Hovering over a selected
//      row does NOT change the preview (the live reorder can scoot
//      selected rows under the cursor; the user's intent hasn't
//      moved).
//   4. onDragEnd single-row: reorderTracks is called with the moved
//      order; visible-vs-hidden positions are preserved.
//   5. onDragEnd multi-row over=selected: falls back to the last
//      unselected over-id seen during the drag. Without this
//      fallback the deliberate multi-drag silently no-ops.
//   6. onDragEnd over=null: no reorder.
//   7. onDragCancel resets every transient state.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import type {
  DragEndEvent,
  DragOverEvent,
  DragStartEvent,
} from "@dnd-kit/core";

vi.mock("../db/draftRepository", () => ({
  saveDraft: vi.fn(async () => undefined),
  loadDraft: vi.fn(async () => ({ playlist: null, tracks: [] })),
}));

vi.mock("../services/cancelTrackRequests", () => ({
  cancelTrackRequests: vi.fn(),
}));

import { usePlaylistStore } from "../store/playlistStore";
import { usePlaylistDragAndDrop } from "./usePlaylistDragAndDrop";
import type { Track } from "../types";

// ─── helpers ─────────────────────────────────────────────────────────

function makeTrack(id: string): Track {
  return {
    id,
    source: { kind: "file", fileName: `${id}.mp3` },
    enrichment: { status: "idle" },
    spotify: { status: "idle" },
  };
}

function resetStore(): void {
  usePlaylistStore.setState({
    playlist: {
      id: "active-draft",
      name: "T",
      description: "",
      public: false,
      collaborative: false,
      trackIds: [],
      sort: null,
      hideUnmatched: false,
    },
    tracksById: {},
    undoStack: [],
    selectedTrackIds: new Set<string>(),
    selectionAnchorId: null,
  });
}

function setupPlaylist(ids: string[]): void {
  const tracksById: Record<string, Track> = {};
  for (const id of ids) tracksById[id] = makeTrack(id);
  usePlaylistStore.setState({
    tracksById,
    playlist: {
      id: "active-draft",
      name: "T",
      description: "",
      public: false,
      collaborative: false,
      trackIds: ids,
      sort: null,
      hideUnmatched: false,
    },
  });
}

// dnd-kit's event types are large; the hook only reads .active.id and
// .over.id. Plain objects with those slots are enough.
function startEvent(activeId: string): DragStartEvent {
  return { active: { id: activeId } } as unknown as DragStartEvent;
}

function overEvent(activeId: string, overId: string | null): DragOverEvent {
  return {
    active: { id: activeId },
    over: overId ? { id: overId } : null,
  } as unknown as DragOverEvent;
}

function endEvent(activeId: string, overId: string | null): DragEndEvent {
  return {
    active: { id: activeId },
    over: overId ? { id: overId } : null,
  } as unknown as DragEndEvent;
}

beforeEach(() => {
  resetStore();
});

afterEach(() => {
  cleanup();
});

// ─── 1. onDragStart ─────────────────────────────────────────────────

describe("usePlaylistDragAndDrop — onDragStart", () => {
  it("on a non-selected row: replaces selection with that single row, multiDragActive=false, dragOverlayCount=1", () => {
    setupPlaylist(["a", "b", "c"]);
    usePlaylistStore.setState({
      selectedTrackIds: new Set(["b"]),
      selectionAnchorId: "b",
    });
    const { result } = renderHook(() =>
      usePlaylistDragAndDrop(["a", "b", "c"], ["a", "b", "c"]),
    );
    act(() => {
      result.current.onDragStart(startEvent("a"));
    });
    // Selection replaced with the dragged row.
    expect(
      Array.from(usePlaylistStore.getState().selectedTrackIds),
    ).toEqual(["a"]);
    expect(result.current.multiDragActive).toBe(false);
    expect(result.current.dragOverlayCount).toBe(1);
    expect(result.current.activeDragTrackId).toBe("a");
  });

  it("on a row that's part of a multi-selection: selection survives, multiDragActive=true, dragOverlayCount=size", () => {
    setupPlaylist(["a", "b", "c", "d"]);
    usePlaylistStore.setState({
      selectedTrackIds: new Set(["a", "b", "c"]),
      selectionAnchorId: "a",
    });
    const { result } = renderHook(() =>
      usePlaylistDragAndDrop(["a", "b", "c", "d"], ["a", "b", "c", "d"]),
    );
    act(() => {
      result.current.onDragStart(startEvent("b"));
    });
    expect(
      Array.from(usePlaylistStore.getState().selectedTrackIds).sort(),
    ).toEqual(["a", "b", "c"]);
    expect(result.current.multiDragActive).toBe(true);
    expect(result.current.dragOverlayCount).toBe(3);
    expect(result.current.activeDragTrackId).toBe("b");
  });

  it("dragging a single-selected row: multiDragActive=false (only one row carried, no \"block\" semantics)", () => {
    setupPlaylist(["a", "b", "c"]);
    usePlaylistStore.setState({
      selectedTrackIds: new Set(["a"]),
      selectionAnchorId: "a",
    });
    const { result } = renderHook(() =>
      usePlaylistDragAndDrop(["a", "b", "c"], ["a", "b", "c"]),
    );
    act(() => {
      result.current.onDragStart(startEvent("a"));
    });
    // multiDragActive is reserved for size > 1 — see the helpers in the
    // hook. dragOverlayCount still reflects the active selection size.
    expect(result.current.multiDragActive).toBe(false);
    expect(result.current.dragOverlayCount).toBe(1);
  });
});

// ─── 2. onDragOver — preview computation ────────────────────────────

describe("usePlaylistDragAndDrop — onDragOver preview", () => {
  it("single-row drag: dragPreviewIds stays null (dnd-kit's native animation handles it)", () => {
    setupPlaylist(["a", "b", "c"]);
    const { result } = renderHook(() =>
      usePlaylistDragAndDrop(["a", "b", "c"], ["a", "b", "c"]),
    );
    act(() => {
      result.current.onDragStart(startEvent("a"));
      result.current.onDragOver(overEvent("a", "c"));
    });
    expect(result.current.dragPreviewIds).toBeNull();
  });

  it("multi-row drag over an UNSELECTED row updates dragPreviewIds to the moved order", () => {
    setupPlaylist(["a", "b", "c", "d"]);
    usePlaylistStore.setState({
      selectedTrackIds: new Set(["a", "b"]),
      selectionAnchorId: "a",
    });
    const { result } = renderHook(() =>
      usePlaylistDragAndDrop(["a", "b", "c", "d"], ["a", "b", "c", "d"]),
    );
    act(() => {
      result.current.onDragStart(startEvent("a"));
      result.current.onDragOver(overEvent("a", "d"));
    });
    // Selection block [a,b] moved past c and d → preview = [c, d, a, b].
    // moveSelectionMaintainingShape's contract; pinned in
    // selectionHelpers.test.ts. The hook delegates to it.
    expect(result.current.dragPreviewIds).not.toBeNull();
    expect(result.current.dragPreviewIds).toEqual(["c", "d", "a", "b"]);
  });

  it("multi-row drag hovering over a SELECTED row does NOT change the preview", () => {
    // The live preview can scoot a selected row under the cursor; the
    // user's intent hasn't moved, so the last valid landing stays.
    setupPlaylist(["a", "b", "c", "d"]);
    usePlaylistStore.setState({
      selectedTrackIds: new Set(["a", "b"]),
      selectionAnchorId: "a",
    });
    const { result } = renderHook(() =>
      usePlaylistDragAndDrop(["a", "b", "c", "d"], ["a", "b", "c", "d"]),
    );
    act(() => {
      result.current.onDragStart(startEvent("a"));
      result.current.onDragOver(overEvent("a", "d"));
    });
    const previewAfterValidOver = result.current.dragPreviewIds;
    expect(previewAfterValidOver).not.toBeNull();
    act(() => {
      // Now hover over the OTHER selected row.
      result.current.onDragOver(overEvent("a", "b"));
    });
    // Preview is unchanged — the over-selected-row case is a hold.
    expect(result.current.dragPreviewIds).toBe(previewAfterValidOver);
  });

  it("multi-row drag with no over: no preview update", () => {
    setupPlaylist(["a", "b", "c"]);
    usePlaylistStore.setState({
      selectedTrackIds: new Set(["a", "b"]),
      selectionAnchorId: "a",
    });
    const { result } = renderHook(() =>
      usePlaylistDragAndDrop(["a", "b", "c"], ["a", "b", "c"]),
    );
    act(() => {
      result.current.onDragStart(startEvent("a"));
      result.current.onDragOver(overEvent("a", null));
    });
    expect(result.current.dragPreviewIds).toBeNull();
  });
});

// ─── 3. onDragEnd — single-row commit ───────────────────────────────

describe("usePlaylistDragAndDrop — onDragEnd single-row", () => {
  it("a single-row drag from a to c reorders to [b, c, a] via arrayMove", () => {
    // arrayMove(['a','b','c'], 0, 2) = ['b','c','a'].
    setupPlaylist(["a", "b", "c"]);
    usePlaylistStore.setState({
      selectedTrackIds: new Set(["a"]),
      selectionAnchorId: "a",
    });
    const { result } = renderHook(() =>
      usePlaylistDragAndDrop(["a", "b", "c"], ["a", "b", "c"]),
    );
    act(() => {
      result.current.onDragStart(startEvent("a"));
      result.current.onDragEnd(endEvent("a", "c"));
    });
    expect(usePlaylistStore.getState().playlist.trackIds).toEqual([
      "b",
      "c",
      "a",
    ]);
  });

  it("a single-row drag where active===over is a no-op", () => {
    setupPlaylist(["a", "b", "c"]);
    usePlaylistStore.setState({
      selectedTrackIds: new Set(["b"]),
      selectionAnchorId: "b",
    });
    const { result } = renderHook(() =>
      usePlaylistDragAndDrop(["a", "b", "c"], ["a", "b", "c"]),
    );
    act(() => {
      result.current.onDragStart(startEvent("b"));
      result.current.onDragEnd(endEvent("b", "b"));
    });
    expect(usePlaylistStore.getState().playlist.trackIds).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("over=null is a no-op (dropped outside any row)", () => {
    setupPlaylist(["a", "b", "c"]);
    usePlaylistStore.setState({
      selectedTrackIds: new Set(["a"]),
      selectionAnchorId: "a",
    });
    const { result } = renderHook(() =>
      usePlaylistDragAndDrop(["a", "b", "c"], ["a", "b", "c"]),
    );
    act(() => {
      result.current.onDragStart(startEvent("a"));
      result.current.onDragEnd(endEvent("a", null));
    });
    expect(usePlaylistStore.getState().playlist.trackIds).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("single-row drag with hidden rows: visible-only reorder, hidden positions preserved", () => {
    // Full list: [a, hidden1, b, hidden2, c]
    // Visible (after hide-unmatched filter): [a, b, c]
    // Drag a → c. New visible order: [b, c, a].
    // The hidden rows stay at indices 1 and 3 of the full list:
    //   index 0 = visible[0] = b
    //   index 1 = hidden1 (preserved)
    //   index 2 = visible[1] = c
    //   index 3 = hidden2 (preserved)
    //   index 4 = visible[2] = a
    setupPlaylist(["a", "hidden1", "b", "hidden2", "c"]);
    usePlaylistStore.setState({
      selectedTrackIds: new Set(["a"]),
      selectionAnchorId: "a",
    });
    const { result } = renderHook(() =>
      usePlaylistDragAndDrop(
        ["a", "b", "c"], // visible
        ["a", "hidden1", "b", "hidden2", "c"], // full
      ),
    );
    act(() => {
      result.current.onDragStart(startEvent("a"));
      result.current.onDragEnd(endEvent("a", "c"));
    });
    expect(usePlaylistStore.getState().playlist.trackIds).toEqual([
      "b",
      "hidden1",
      "c",
      "hidden2",
      "a",
    ]);
  });
});

// ─── 4. onDragEnd — multi-row commit ────────────────────────────────

describe("usePlaylistDragAndDrop — onDragEnd multi-row", () => {
  it("multi-row drag commits the moveSelectionMaintainingShape order", () => {
    setupPlaylist(["a", "b", "c", "d"]);
    usePlaylistStore.setState({
      selectedTrackIds: new Set(["a", "b"]),
      selectionAnchorId: "a",
    });
    const { result } = renderHook(() =>
      usePlaylistDragAndDrop(["a", "b", "c", "d"], ["a", "b", "c", "d"]),
    );
    act(() => {
      result.current.onDragStart(startEvent("a"));
      result.current.onDragOver(overEvent("a", "d"));
      result.current.onDragEnd(endEvent("a", "d"));
    });
    // Same target as the preview produced in the onDragOver test:
    // [c, d, a, b].
    expect(usePlaylistStore.getState().playlist.trackIds).toEqual([
      "c",
      "d",
      "a",
      "b",
    ]);
  });

  it("multi-row drag where over.id is a selected row: falls back to lastUnselectedOverIdRef", () => {
    // The user dragged across an unselected row (d) THEN the preview
    // scooted a selected row (b) under the cursor by release time.
    // dnd-kit reports over.id=b — a selected row. Without the
    // fallback the move silently no-ops. WITH the fallback, the hook
    // uses d (the last unselected over) and the move commits.
    setupPlaylist(["a", "b", "c", "d"]);
    usePlaylistStore.setState({
      selectedTrackIds: new Set(["a", "b"]),
      selectionAnchorId: "a",
    });
    const { result } = renderHook(() =>
      usePlaylistDragAndDrop(["a", "b", "c", "d"], ["a", "b", "c", "d"]),
    );
    act(() => {
      result.current.onDragStart(startEvent("a"));
      result.current.onDragOver(overEvent("a", "d")); // records d as lastUnselectedOver
      result.current.onDragEnd(endEvent("a", "b")); // over=selected; should fall back to d
    });
    expect(usePlaylistStore.getState().playlist.trackIds).toEqual([
      "c",
      "d",
      "a",
      "b",
    ]);
  });

  it("multi-row drag where every observed over was selected: no fallback to commit, no-op", () => {
    // No unselected over was ever recorded — the fallback is null and
    // the hook bails. The user's drag effectively didn't pick a
    // target.
    setupPlaylist(["a", "b", "c", "d"]);
    usePlaylistStore.setState({
      selectedTrackIds: new Set(["a", "b"]),
      selectionAnchorId: "a",
    });
    const { result } = renderHook(() =>
      usePlaylistDragAndDrop(["a", "b", "c", "d"], ["a", "b", "c", "d"]),
    );
    act(() => {
      result.current.onDragStart(startEvent("a"));
      // Only hovers selected rows during the drag.
      result.current.onDragOver(overEvent("a", "b"));
      result.current.onDragEnd(endEvent("a", "b"));
    });
    expect(usePlaylistStore.getState().playlist.trackIds).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
  });

  it("multi-row drag with hidden rows: hidden positions preserved", () => {
    // Visible [a, b, c, d], full [a, b, hidden, c, d]. Multi-drag
    // {a,b} past d → visible result [c, d, a, b]. Hidden stays at
    // its full-list index 2.
    setupPlaylist(["a", "b", "hidden", "c", "d"]);
    usePlaylistStore.setState({
      selectedTrackIds: new Set(["a", "b"]),
      selectionAnchorId: "a",
    });
    const { result } = renderHook(() =>
      usePlaylistDragAndDrop(
        ["a", "b", "c", "d"],
        ["a", "b", "hidden", "c", "d"],
      ),
    );
    act(() => {
      result.current.onDragStart(startEvent("a"));
      result.current.onDragOver(overEvent("a", "d"));
      result.current.onDragEnd(endEvent("a", "d"));
    });
    expect(usePlaylistStore.getState().playlist.trackIds).toEqual([
      "c",
      "d",
      "hidden",
      "a",
      "b",
    ]);
  });
});

// ─── 5. onDragCancel ────────────────────────────────────────────────

describe("usePlaylistDragAndDrop — onDragCancel", () => {
  it("resets every transient state and does NOT touch the playlist", () => {
    setupPlaylist(["a", "b", "c"]);
    usePlaylistStore.setState({
      selectedTrackIds: new Set(["a", "b"]),
      selectionAnchorId: "a",
    });
    const { result } = renderHook(() =>
      usePlaylistDragAndDrop(["a", "b", "c"], ["a", "b", "c"]),
    );
    act(() => {
      result.current.onDragStart(startEvent("a"));
      result.current.onDragOver(overEvent("a", "c"));
    });
    expect(result.current.dragPreviewIds).not.toBeNull();
    expect(result.current.activeDragTrackId).toBe("a");

    act(() => {
      result.current.onDragCancel();
    });

    expect(result.current.dragPreviewIds).toBeNull();
    expect(result.current.multiDragActive).toBe(false);
    expect(result.current.activeDragTrackId).toBeNull();
    expect(result.current.dragOverlayCount).toBe(0);
    // Playlist order untouched.
    expect(usePlaylistStore.getState().playlist.trackIds).toEqual([
      "a",
      "b",
      "c",
    ]);
  });
});
