import { describe, expect, it } from "vitest";
import {
  moveSelectionBlock,
  moveSelectionBlockToEnd,
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

describe("moveSelectionBlock", () => {
  it("moves a contiguous block before the target id", () => {
    const next = moveSelectionBlock(
      ["a", "b", "c", "d", "e"],
      ["b", "c"],
      "e",
    );
    expect(next).toEqual(["a", "d", "b", "c", "e"]);
  });

  it("collapses a non-contiguous selection into a contiguous block", () => {
    const next = moveSelectionBlock(
      ["a", "b", "c", "d", "e"],
      ["a", "c", "e"],
      "d",
    );
    // a, c, e removed → [b, d]. Insert before d → [b, a, c, e, d].
    expect(next).toEqual(["b", "a", "c", "e", "d"]);
  });

  it("preserves the source order of the selected ids in the moved block", () => {
    const next = moveSelectionBlock(
      ["a", "b", "c", "d"],
      ["d", "b"],
      "a",
    );
    // selectedSet = {b, d}; surviving = [a, c]; block in source order = [b, d].
    // Insert before a → [b, d, a, c].
    expect(next).toEqual(["b", "d", "a", "c"]);
  });

  it("returns the same reference when the target is part of the selection", () => {
    const ids = ["a", "b", "c", "d"];
    expect(moveSelectionBlock(ids, ["b", "c"], "b")).toBe(ids);
  });

  it("returns the same reference when the move is a no-op", () => {
    const ids = ["a", "b", "c", "d"];
    // dropping a,b before c is already where they are
    expect(moveSelectionBlock(ids, ["a", "b"], "c")).toBe(ids);
  });

  it("returns the same reference when target id isn't in the list", () => {
    const ids = ["a", "b", "c"];
    expect(moveSelectionBlock(ids, ["a"], "zzz")).toBe(ids);
  });
});

describe("moveSelectionBlockToEnd", () => {
  it("moves selection to the end preserving source order", () => {
    expect(
      moveSelectionBlockToEnd(["a", "b", "c", "d"], ["a", "c"]),
    ).toEqual(["b", "d", "a", "c"]);
  });

  it("returns same reference when block is already trailing", () => {
    const ids = ["a", "b", "c"];
    expect(moveSelectionBlockToEnd(ids, ["b", "c"])).toBe(ids);
  });
});
