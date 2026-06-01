import { describe, expect, it } from "vitest";
import {
  moveSelectionMaintainingShape,
  rangeBetween,
} from "./selectionHelpers";

describe("rangeBetween", () => {
  it("returns just the target when no anchor is set", () => {
    expect(rangeBetween(["a", "b", "c"], null, "b")).toEqual(["b"]);
  });

  it("returns inclusive range when anchor precedes target", () => {
    expect(rangeBetween(["a", "b", "c", "d"], "b", "d")).toEqual(["b", "c", "d"]);
  });

  it("returns inclusive range when anchor follows target", () => {
    expect(rangeBetween(["a", "b", "c", "d"], "d", "b")).toEqual(["b", "c", "d"]);
  });

  it("falls back to just the target when anchor isn't visible", () => {
    expect(rangeBetween(["a", "b", "c"], "zzz", "b")).toEqual(["b"]);
  });
});

describe("moveSelectionMaintainingShape", () => {
  it("keeps the selection's internal gap when there's room (user's first example)", () => {
    // [A, B, C, D] with {A, C} selected, grab A, drag down over B.
    const next = moveSelectionMaintainingShape(
      ["A", "B", "C", "D"],
      new Set(["A", "C"]),
      "A",
      "B",
    );
    // A→1, C keeps its +2 offset → 3; D flows into the gap, B moves above.
    expect(next).toEqual(["B", "A", "D", "C"]);
  });

  it("collapses the gap only when the bottom of the array is reached (user's second example)", () => {
    // [A, B, C, D] with {A, C} selected, grab A, drag down over D.
    const next = moveSelectionMaintainingShape(
      ["A", "B", "C", "D"],
      new Set(["A", "C"]),
      "A",
      "D",
    );
    // C would want index 4 (off the end) → gap collapses at the boundary.
    expect(next).toEqual(["B", "D", "A", "C"]);
  });

  it("moves the selection one slot at a time as the cursor crosses unselected rows (contiguous)", () => {
    // [A, B, C, D, E] {A, B} (contiguous), grab A. Each step down past one
    // unselected row shifts the 2-row block by exactly ONE slot — NOT two.
    const ids = ["A", "B", "C", "D", "E"];
    const sel = new Set(["A", "B"]);
    expect(moveSelectionMaintainingShape(ids, sel, "A", "C")).toEqual([
      "C", "A", "B", "D", "E",
    ]);
    expect(moveSelectionMaintainingShape(ids, sel, "A", "D")).toEqual([
      "C", "D", "A", "B", "E",
    ]);
    expect(moveSelectionMaintainingShape(ids, sel, "A", "E")).toEqual([
      "C", "D", "E", "A", "B",
    ]);
  });

  it("keeps a non-contiguous gap intact while dragging, flowing rows through it", () => {
    // [A, B, C, D, E] {A, C} (gap of 1). Dragging down keeps exactly one
    // unselected row between A and C; a different row occupies the gap at
    // each step (B → D), so the shape is preserved, not collapsed.
    const ids = ["A", "B", "C", "D", "E"];
    const sel = new Set(["A", "C"]);
    // Over B: A→1, C→3, gap at 2 holds D.
    expect(moveSelectionMaintainingShape(ids, sel, "A", "B")).toEqual([
      "B", "A", "D", "C", "E",
    ]);
    // Over D: A→2, C→4, gap at 3 holds E. (E is at the last slot, so the
    // A–C gap is still intact — collapse hasn't been forced yet.)
    expect(moveSelectionMaintainingShape(ids, sel, "A", "D")).toEqual([
      "B", "D", "A", "E", "C",
    ]);
  });

  it("produces different anchors depending on whether the leading or trailing row was grabbed", () => {
    // The grabbed row is the one that tracks the cursor; the other selected
    // row follows via its original offset.
    const grabLeading = moveSelectionMaintainingShape(
      ["A", "B", "C", "D"],
      new Set(["A", "C"]),
      "A",
      "D",
    );
    const grabTrailing = moveSelectionMaintainingShape(
      ["A", "B", "C", "D"],
      new Set(["A", "C"]),
      "C",
      "D",
    );
    expect(grabLeading).toEqual(["B", "D", "A", "C"]);
    expect(grabTrailing).toEqual(["B", "A", "D", "C"]);
  });

  it("preserves gaps of arbitrary size when the array has room", () => {
    // [A, B, C, D, E, F] selected {A, C, E} (offsets 0, 2, 4); grab A, over B.
    const next = moveSelectionMaintainingShape(
      ["A", "B", "C", "D", "E", "F"],
      new Set(["A", "C", "E"]),
      "A",
      "B",
    );
    // A→1, C→3 (gap → D), E→5 (gap → F), B at 0.
    expect(next).toEqual(["B", "A", "D", "C", "F", "E"]);
  });

  it("collapses only the gaps forced off the end, preserving the rest", () => {
    // Same selection, grab A, over D. E hits the last slot so the C–E gap
    // collapses, but the A–C gap survives (F flows into it).
    const next = moveSelectionMaintainingShape(
      ["A", "B", "C", "D", "E", "F"],
      new Set(["A", "C", "E"]),
      "A",
      "D",
    );
    expect(next).toEqual(["B", "D", "A", "F", "C", "E"]);
  });

  it("places items before the active row using the backward pass", () => {
    // Grab D (trailing selected) from {B, D}, drag down over E.
    const next = moveSelectionMaintainingShape(
      ["A", "B", "C", "D", "E", "F"],
      new Set(["B", "D"]),
      "D",
      "E",
    );
    // D tracks toward E's slot; B follows 2 slots behind via its offset.
    expect(next).toEqual(["A", "C", "B", "E", "D", "F"]);
  });

  it("returns the same reference when target is in the selection (drop-on-self guard)", () => {
    const ids = ["A", "B", "C", "D"];
    expect(
      moveSelectionMaintainingShape(ids, new Set(["A", "C"]), "A", "C"),
    ).toBe(ids);
  });

  it("returns the same reference when active is not in the selection", () => {
    const ids = ["A", "B", "C"];
    expect(
      moveSelectionMaintainingShape(ids, new Set(["B"]), "A", "C"),
    ).toBe(ids);
  });

  it("returns the same reference when over isn't in the visible list", () => {
    const ids = ["A", "B", "C"];
    expect(
      moveSelectionMaintainingShape(ids, new Set(["A"]), "A", "ZZZ"),
    ).toBe(ids);
  });
});
