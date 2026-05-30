// @vitest-environment happy-dom
//
// Tests for useRubberbandSelection — marquee selection in the
// virtualized playlist table. The hook walks a narrow line: it must
// stay out of the way when the user is just clicking (so the row's
// onClick still fires for plain selection), but commit to drag-mode
// once the pointer travels past the 6 px threshold and update
// selection live as the rect grows.
//
// Behaviors locked in here:
//
//   1. Pressing on an interactive descendant (button, anchor, input,
//      role=button, data-no-rubberband) bails — no listener state is
//      retained, so a click on a row's per-row trash icon never
//      becomes a rubber-band.
//   2. A press without crossing the 6 px threshold is treated as a
//      click — selection unchanged, suppressClickRef stays false.
//   3. Crossing the threshold activates the drag. Selection is set to
//      the union of rows whose Y-bands intersect the rect, computed
//      against the visibleAtPressRef SNAPSHOT — so a concurrent
//      filter change can't shift the index math mid-drag.
//   4. Shift / Meta / Ctrl at press-down → additive: the prior
//      selection survives the drag and is merged with the rect.
//   5. On drag end, suppressClickRef is set true so the row's
//      synthetic click event is swallowed by the consumer.
//
// happy-dom doesn't compute layout, so getBoundingClientRect/scrollTop
// are stubbed at the container level.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useEffect, useRef } from "react";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import type { MutableRefObject } from "react";
import { ROW_HEIGHT_PX } from "../constants";

vi.mock("../db/draftRepository", () => ({
  saveDraft: vi.fn(async () => undefined),
  loadDraft: vi.fn(async () => ({ playlist: null, tracks: [] })),
}));

vi.mock("../services/cancelTrackRequests", () => ({
  cancelTrackRequests: vi.fn(),
}));

import { usePlaylistStore } from "../store/playlistStore";
import { useRubberbandSelection } from "./useRubberbandSelection";
import type { Track } from "../types";

// ─── Test harness ────────────────────────────────────────────────────

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
      name: "Test",
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

beforeEach(() => {
  resetStore();
  capturedSuppressClickRef = null;
});

afterEach(() => {
  cleanup();
});

// Renders a fake virtualized container with a fixed bounding rect and
// scrollTop. The hook's suppressClickRef is exposed via a module-scope
// hook reference that the test reads after each event. Module scope
// (vs. passing a probes prop) keeps the harness props immutable, which
// the project's react-hooks lint rule requires.
//
// Tests are serial in vitest (default), so the module-scope ref is
// fine. resetCapturedRef in beforeEach clears it between tests.

let capturedSuppressClickRef: MutableRefObject<boolean> | null = null;

function Harness({
  visibleTrackIds,
  rect = { left: 0, top: 100, width: 400, height: 600 },
  scrollTop = 0,
  innerContent,
}: {
  visibleTrackIds: string[];
  rect?: { left: number; top: number; width: number; height: number };
  scrollTop?: number;
  innerContent?: React.ReactNode;
}) {
  const parentRef = useRef<HTMLDivElement | null>(null);
  const { onContainerPointerDown, suppressClickRef } = useRubberbandSelection(
    parentRef,
    visibleTrackIds,
  );
  // Capture for tests via a commit-phase effect (the project's
  // react-hooks rule forbids mutating non-local values during render,
  // including inside ref callbacks).
  useEffect(() => {
    capturedSuppressClickRef = suppressClickRef;
  });
  return (
    <div
      ref={(el) => {
        parentRef.current = el;
        if (el) {
          // happy-dom returns zero-sized rects; stub the geometry the
          // hook reads so we can drive math from the test.
          el.getBoundingClientRect = () =>
            ({
              ...rect,
              right: rect.left + rect.width,
              bottom: rect.top + rect.height,
              x: rect.left,
              y: rect.top,
              toJSON() {},
            }) as DOMRect;
          Object.defineProperty(el, "scrollTop", {
            configurable: true,
            value: scrollTop,
          });
        }
      }}
      onPointerDown={onContainerPointerDown}
      data-testid="container"
    >
      {innerContent}
    </div>
  );
}

function suppressClickValue(): boolean {
  return capturedSuppressClickRef?.current ?? false;
}

function fireWindowPointer(
  type: "pointermove" | "pointerup" | "pointercancel",
  opts: { clientX: number; clientY: number; pointerId?: number },
) {
  const evt = new Event(type) as PointerEvent;
  Object.defineProperties(evt, {
    clientX: { value: opts.clientX },
    clientY: { value: opts.clientY },
    pointerId: { value: opts.pointerId ?? 1 },
  });
  window.dispatchEvent(evt);
}

// ─── 1. Press on an interactive descendant: bail ────────────────────

describe("useRubberbandSelection — press target gating", () => {
  it("press on a <button> descendant does NOT start a drag", () => {
    usePlaylistStore.setState({
      tracksById: {
        a: makeTrack("a"),
        b: makeTrack("b"),
        c: makeTrack("c"),
      },
      playlist: {
        id: "active-draft",
        name: "T",
        description: "",
        public: false,
        collaborative: false,
        trackIds: ["a", "b", "c"],
        sort: null,
        hideUnmatched: false,
      },
    });
    const { getByTestId } = render(
      <Harness
        visibleTrackIds={["a", "b", "c"]}
       
        innerContent={<button data-testid="inner-btn">x</button>}
      />,
    );
    const btn = getByTestId("inner-btn");
    fireEvent.pointerDown(btn, {
      button: 0,
      clientX: 10,
      clientY: 200,
      pointerId: 1,
    });
    // Move past threshold.
    fireWindowPointer("pointermove", { clientX: 200, clientY: 400 });
    // Selection unchanged.
    expect(usePlaylistStore.getState().selectedTrackIds.size).toBe(0);
    // suppressClickRef stays false.
    expect(suppressClickValue()).toBe(false);
  });

  it("press with non-primary button does NOT start a drag", () => {
    usePlaylistStore.setState({
      tracksById: { a: makeTrack("a") },
      playlist: {
        id: "active-draft",
        name: "T",
        description: "",
        public: false,
        collaborative: false,
        trackIds: ["a"],
        sort: null,
        hideUnmatched: false,
      },
    });
    const { getByTestId } = render(
      <Harness visibleTrackIds={["a"]} />,
    );
    const container = getByTestId("container");
    // Right-click (button=2) must not arm the drag — that gesture is
    // reserved for the browser's context menu.
    fireEvent.pointerDown(container, {
      button: 2,
      clientX: 10,
      clientY: 200,
      pointerId: 1,
    });
    fireWindowPointer("pointermove", { clientX: 200, clientY: 400 });
    expect(usePlaylistStore.getState().selectedTrackIds.size).toBe(0);
  });
});

// ─── 2. Below-threshold = click, not drag ───────────────────────────

describe("useRubberbandSelection — threshold gating", () => {
  it("pointerup without crossing 6 px is treated as a click — selection unchanged, suppressClickRef stays false", () => {
    usePlaylistStore.setState({
      tracksById: { a: makeTrack("a"), b: makeTrack("b") },
      playlist: {
        id: "active-draft",
        name: "T",
        description: "",
        public: false,
        collaborative: false,
        trackIds: ["a", "b"],
        sort: null,
        hideUnmatched: false,
      },
    });
    const { getByTestId } = render(
      <Harness visibleTrackIds={["a", "b"]} />,
    );
    const container = getByTestId("container");
    fireEvent.pointerDown(container, { button: 0, clientX: 10, clientY: 200 });
    // 4 px down — under the 6 px activation threshold.
    fireWindowPointer("pointermove", { clientX: 10, clientY: 204 });
    fireWindowPointer("pointerup", { clientX: 10, clientY: 204 });
    expect(usePlaylistStore.getState().selectedTrackIds.size).toBe(0);
    expect(suppressClickValue()).toBe(false);
  });
});

// ─── 3. Above-threshold: drag commits a selection ───────────────────

describe("useRubberbandSelection — drag selection", () => {
  it("dragging across rows 0..2 selects all three (replace mode)", () => {
    usePlaylistStore.setState({
      tracksById: {
        a: makeTrack("a"),
        b: makeTrack("b"),
        c: makeTrack("c"),
        d: makeTrack("d"),
      },
      playlist: {
        id: "active-draft",
        name: "T",
        description: "",
        public: false,
        collaborative: false,
        trackIds: ["a", "b", "c", "d"],
        sort: null,
        hideUnmatched: false,
      },
    });
    // Container is at viewport top=100, scrollTop=0. Rows are 44 px.
    // Row indices 0,1,2 cover container-Y in [0,132).
    // Press at container-Y 0 (client-Y = 100), drag to container-Y
    // 100 (client-Y = 200) — covers rows 0..2.
    const { getByTestId } = render(
      <Harness visibleTrackIds={["a", "b", "c", "d"]} />,
    );
    const container = getByTestId("container");
    fireEvent.pointerDown(container, {
      button: 0,
      clientX: 50,
      clientY: 100,
      pointerId: 1,
    });
    fireWindowPointer("pointermove", { clientX: 50, clientY: 200 });

    const selection = Array.from(
      usePlaylistStore.getState().selectedTrackIds,
    ).sort();
    expect(selection).toEqual(["a", "b", "c"]);
  });

  it("snapshots visibleTrackIds at press-down — a mid-drag filter change does not shift index math", () => {
    // The hook captures `visibleAtPressRef.current = visibleIdsRef
    // .current.slice()` synchronously inside pointerDown. After the
    // press, even if visibleTrackIds changes (because hideUnmatched
    // flipped, a track resolved, etc.), the rubber-band keeps
    // selecting against the captured snapshot.
    usePlaylistStore.setState({
      tracksById: {
        a: makeTrack("a"),
        b: makeTrack("b"),
        c: makeTrack("c"),
      },
      playlist: {
        id: "active-draft",
        name: "T",
        description: "",
        public: false,
        collaborative: false,
        trackIds: ["a", "b", "c"],
        sort: null,
        hideUnmatched: false,
      },
    });
    const { getByTestId, rerender } = render(
      <Harness visibleTrackIds={["a", "b", "c"]} />,
    );
    const container = getByTestId("container");
    fireEvent.pointerDown(container, {
      button: 0,
      clientX: 50,
      clientY: 100,
      pointerId: 1,
    });
    // BEFORE moving the pointer, simulate a concurrent filter that
    // removes "b" from the visible set.
    rerender(<Harness visibleTrackIds={["a", "c"]} />);
    // Now drag across what used to be rows 0..2 (Y 0..100).
    fireWindowPointer("pointermove", { clientX: 50, clientY: 200 });

    // Selection should be a, b, c — index math used the snapshot,
    // NOT the post-rerender array (which would yield only a, c).
    const selection = Array.from(
      usePlaylistStore.getState().selectedTrackIds,
    ).sort();
    expect(selection).toEqual(["a", "b", "c"]);
  });

  it("shift held at press → additive: prior selection survives, drag adds new rows", () => {
    usePlaylistStore.setState({
      tracksById: {
        a: makeTrack("a"),
        b: makeTrack("b"),
        c: makeTrack("c"),
        d: makeTrack("d"),
      },
      playlist: {
        id: "active-draft",
        name: "T",
        description: "",
        public: false,
        collaborative: false,
        trackIds: ["a", "b", "c", "d"],
        sort: null,
        hideUnmatched: false,
      },
      selectedTrackIds: new Set(["d"]),
      selectionAnchorId: "d",
    });
    const { getByTestId } = render(
      <Harness visibleTrackIds={["a", "b", "c", "d"]} />,
    );
    const container = getByTestId("container");
    fireEvent.pointerDown(container, {
      button: 0,
      clientX: 50,
      clientY: 100,
      shiftKey: true,
      pointerId: 1,
    });
    // Drag covers rows 0..1.
    fireWindowPointer("pointermove", { clientX: 50, clientY: 150 });

    const selection = Array.from(
      usePlaylistStore.getState().selectedTrackIds,
    ).sort();
    // Additive: prior d survives; drag adds a, b.
    expect(selection).toEqual(["a", "b", "d"]);
  });

  it("preserves the pre-drag selection anchor through a marquee", () => {
    // Regression: the marquee must not destroy the shift-extend pivot.
    // A previous version called setSelection(ids) with no anchor, which
    // defaulted selectionAnchorId to null — so a following Shift+Click /
    // Shift+Arrow degraded to single-select.
    usePlaylistStore.setState({
      tracksById: {
        a: makeTrack("a"),
        b: makeTrack("b"),
        c: makeTrack("c"),
        d: makeTrack("d"),
      },
      playlist: {
        id: "active-draft",
        name: "T",
        description: "",
        public: false,
        collaborative: false,
        trackIds: ["a", "b", "c", "d"],
        sort: null,
        hideUnmatched: false,
      },
      selectedTrackIds: new Set(["d"]),
      selectionAnchorId: "d",
    });
    const { getByTestId } = render(
      <Harness visibleTrackIds={["a", "b", "c", "d"]} />,
    );
    const container = getByTestId("container");
    fireEvent.pointerDown(container, {
      button: 0,
      clientX: 50,
      clientY: 100,
      pointerId: 1,
    });
    fireWindowPointer("pointermove", { clientX: 50, clientY: 150 });
    // Selection was replaced by the marquee, but the anchor is preserved.
    expect(usePlaylistStore.getState().selectionAnchorId).toBe("d");
  });

  it("non-additive press REPLACES the prior selection", () => {
    usePlaylistStore.setState({
      tracksById: {
        a: makeTrack("a"),
        b: makeTrack("b"),
        c: makeTrack("c"),
        d: makeTrack("d"),
      },
      playlist: {
        id: "active-draft",
        name: "T",
        description: "",
        public: false,
        collaborative: false,
        trackIds: ["a", "b", "c", "d"],
        sort: null,
        hideUnmatched: false,
      },
      selectedTrackIds: new Set(["d"]),
      selectionAnchorId: "d",
    });
    const { getByTestId } = render(
      <Harness visibleTrackIds={["a", "b", "c", "d"]} />,
    );
    const container = getByTestId("container");
    fireEvent.pointerDown(container, {
      button: 0,
      clientX: 50,
      clientY: 100,
      pointerId: 1,
    });
    fireWindowPointer("pointermove", { clientX: 50, clientY: 150 });

    const selection = Array.from(
      usePlaylistStore.getState().selectedTrackIds,
    ).sort();
    // Replace: d is gone.
    expect(selection).toEqual(["a", "b"]);
  });
});

// ─── 4. suppressClickRef ────────────────────────────────────────────

describe("useRubberbandSelection — suppressClickRef on drag end", () => {
  it("after a drag exceeded threshold and released, suppressClickRef is true (then cleared on next macrotask)", async () => {
    usePlaylistStore.setState({
      tracksById: { a: makeTrack("a"), b: makeTrack("b") },
      playlist: {
        id: "active-draft",
        name: "T",
        description: "",
        public: false,
        collaborative: false,
        trackIds: ["a", "b"],
        sort: null,
        hideUnmatched: false,
      },
    });
    const { getByTestId } = render(
      <Harness visibleTrackIds={["a", "b"]} />,
    );
    const container = getByTestId("container");
    fireEvent.pointerDown(container, {
      button: 0,
      clientX: 50,
      clientY: 100,
      pointerId: 1,
    });
    fireWindowPointer("pointermove", { clientX: 50, clientY: 150 });
    fireWindowPointer("pointerup", { clientX: 50, clientY: 150 });
    // Immediately after pointerup, the click-suppression flag is on.
    expect(suppressClickValue()).toBe(true);
    // Production schedules a setTimeout(0) to reset. Drain a macrotask.
    await act(
      () =>
        new Promise<void>((resolve) =>
          setTimeout(() => {
            resolve();
          }, 0),
        ),
    );
    expect(suppressClickValue()).toBe(false);
  });

  it("pointercancel ends the drag without setting suppressClickRef true", () => {
    // Cancel arrives from the browser when a system gesture preempts
    // the pointer (touch-to-scroll, OS interrupt). Treat the gesture
    // as if it never happened — selection should NOT be left in a
    // suppress state.
    usePlaylistStore.setState({
      tracksById: { a: makeTrack("a") },
      playlist: {
        id: "active-draft",
        name: "T",
        description: "",
        public: false,
        collaborative: false,
        trackIds: ["a"],
        sort: null,
        hideUnmatched: false,
      },
    });
    const { getByTestId } = render(
      <Harness visibleTrackIds={["a"]} />,
    );
    const container = getByTestId("container");
    fireEvent.pointerDown(container, {
      button: 0,
      clientX: 50,
      clientY: 100,
      pointerId: 1,
    });
    fireWindowPointer("pointermove", { clientX: 50, clientY: 150 });
    fireWindowPointer("pointercancel", { clientX: 50, clientY: 150 });
    expect(suppressClickValue()).toBe(false);
  });
});

// ─── 5. ROW_HEIGHT_PX sanity check ──────────────────────────────────
//
// The pixel-to-row math assumes ROW_HEIGHT_PX = 44; if the constant
// changes, the geometry in the drag tests above is wrong. Surface that
// coupling.

describe("useRubberbandSelection — geometry constant", () => {
  it("ROW_HEIGHT_PX is 44 (these tests' Y math assumes that)", () => {
    expect(ROW_HEIGHT_PX).toBe(44);
  });
});
