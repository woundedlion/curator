// @vitest-environment happy-dom
//
// Tests for useTableKeyboardNav — the window-level keyboard handler for
// the playlist grid. The pure state-machine math lives in
// keyboardNav.test.ts; this file covers the side-effecting behaviors the
// hook owns that the pure helper can't: store writes, scoping to the
// grid, and (the focus of this file) the Space/Enter cursor-row toggle
// added so there's a keyboard path to toggle the cursor row's selection.
//
// The cursor row is the store's selectionAnchorId — the row keyboard nav
// last landed on. Rows are tabIndex=-1 and DOM focus lives on the grid
// container, so the row's own (removed) onKeyDown could never fire; this
// hook is the only keyboard route to the toggle.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRef } from "react";
import { cleanup, render } from "@testing-library/react";

vi.mock("../db/draftRepository", () => ({
  saveDraft: vi.fn(async () => undefined),
  loadDraft: vi.fn(async () => ({ playlist: null, tracks: [] })),
}));
vi.mock("../services/cancelTrackRequests", () => ({
  cancelTrackRequests: vi.fn(),
}));

import { usePlaylistStore } from "../store/playlistStore";
import { useTableKeyboardNav } from "./useTableKeyboardNav";

function Harness({
  visibleTrackIds,
  onDeleteSelection = () => {},
}: {
  visibleTrackIds: string[];
  onDeleteSelection?: () => void;
}) {
  const gridRef = useRef<HTMLDivElement | null>(null);
  useTableKeyboardNav({
    visibleTrackIds,
    getPageSize: () => 3,
    scrollToIndex: () => {},
    onDeleteSelection,
    gridRef,
  });
  // The grid container must own focus for the window handler to act
  // (otherwise an unrelated focusable would keep the keystroke).
  return <div ref={gridRef} tabIndex={-1} data-testid="grid" />;
}

function resetStore(): void {
  usePlaylistStore.setState({
    selectedTrackIds: new Set<string>(),
    selectionAnchorId: null,
  });
}

function dispatchKey(key: string): KeyboardEvent {
  const evt = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
  });
  window.dispatchEvent(evt);
  return evt;
}

beforeEach(() => {
  resetStore();
});

afterEach(() => {
  cleanup();
});

describe("useTableKeyboardNav — Space/Enter toggles the cursor row", () => {
  it("Space toggles selection ON the cursor (anchor) row and prevents default", () => {
    // Cursor (anchor) = "b", nothing selected yet.
    usePlaylistStore.setState({
      selectedTrackIds: new Set<string>(),
      selectionAnchorId: "b",
    });
    render(<Harness visibleTrackIds={["a", "b", "c"]} />);

    const evt = dispatchKey(" ");
    // Default prevented so the page doesn't scroll on Space.
    expect(evt.defaultPrevented).toBe(true);
    // "b" is now selected.
    expect(usePlaylistStore.getState().selectedTrackIds.has("b")).toBe(true);
  });

  it("Space again toggles the cursor row back OFF", () => {
    usePlaylistStore.setState({
      selectedTrackIds: new Set<string>(["b"]),
      selectionAnchorId: "b",
    });
    render(<Harness visibleTrackIds={["a", "b", "c"]} />);

    dispatchKey(" ");
    // toggleSelection removed it; the anchor it was on is cleared too.
    expect(usePlaylistStore.getState().selectedTrackIds.has("b")).toBe(false);
  });

  it("Enter behaves the same as Space (toggles the cursor row)", () => {
    usePlaylistStore.setState({
      selectedTrackIds: new Set<string>(),
      selectionAnchorId: "c",
    });
    render(<Harness visibleTrackIds={["a", "b", "c"]} />);

    const evt = dispatchKey("Enter");
    expect(evt.defaultPrevented).toBe(true);
    expect(usePlaylistStore.getState().selectedTrackIds.has("c")).toBe(true);
  });

  it("does nothing (and does NOT preventDefault) when there is no cursor", () => {
    usePlaylistStore.setState({
      selectedTrackIds: new Set<string>(),
      selectionAnchorId: null,
    });
    render(<Harness visibleTrackIds={["a", "b", "c"]} />);

    const evt = dispatchKey(" ");
    // No cursor → bail so Space keeps its default (e.g. page scroll).
    expect(evt.defaultPrevented).toBe(false);
    expect(usePlaylistStore.getState().selectedTrackIds.size).toBe(0);
  });

  it("does nothing when the cursor row is no longer visible", () => {
    // Anchor points at a row that was filtered/removed from the list.
    usePlaylistStore.setState({
      selectedTrackIds: new Set<string>(),
      selectionAnchorId: "zzz-deleted",
    });
    render(<Harness visibleTrackIds={["a", "b", "c"]} />);

    const evt = dispatchKey(" ");
    expect(evt.defaultPrevented).toBe(false);
    expect(usePlaylistStore.getState().selectedTrackIds.size).toBe(0);
  });
});

describe("useTableKeyboardNav — existing nav still works alongside the toggle", () => {
  it("ArrowDown from no cursor lands on the first row (regression guard)", () => {
    usePlaylistStore.setState({
      selectedTrackIds: new Set<string>(),
      selectionAnchorId: null,
    });
    render(<Harness visibleTrackIds={["a", "b", "c"]} />);

    const evt = dispatchKey("ArrowDown");
    expect(evt.defaultPrevented).toBe(true);
    expect(usePlaylistStore.getState().selectionAnchorId).toBe("a");
  });

  it("Escape clears a non-empty selection", () => {
    usePlaylistStore.setState({
      selectedTrackIds: new Set<string>(["a", "b"]),
      selectionAnchorId: "a",
    });
    render(<Harness visibleTrackIds={["a", "b", "c"]} />);

    dispatchKey("Escape");
    expect(usePlaylistStore.getState().selectedTrackIds.size).toBe(0);
  });

  it("a keystroke right after a re-render reads the FRESH visibleTrackIds (layout-effect sync, no stale window)", () => {
    // The ref-sync effect is a useLayoutEffect, so the visibleTrackIds
    // ref is current the moment the commit completes — before control
    // returns to the event loop. We dispatch a Space toggle against the
    // cursor row immediately after a rerender that newly includes that
    // row; if the ref were synced via a passive effect, the keydown could
    // fire before the flush and read the prior (shorter) id list, so the
    // `visibleIds.includes(cursorId)` guard would reject the toggle.
    usePlaylistStore.setState({
      selectedTrackIds: new Set<string>(),
      selectionAnchorId: "d",
    });
    const { rerender } = render(<Harness visibleTrackIds={["a", "b", "c"]} />);
    // "d" is the cursor but not yet visible — a toggle here would bail.
    // Rerender to bring "d" into the visible set, then dispatch WITHOUT
    // awaiting any microtask/paint.
    rerender(<Harness visibleTrackIds={["a", "b", "c", "d"]} />);
    const evt = dispatchKey(" ");
    // The handler saw the fresh list including "d" and toggled it on.
    expect(evt.defaultPrevented).toBe(true);
    expect(usePlaylistStore.getState().selectedTrackIds.has("d")).toBe(true);
  });
});
