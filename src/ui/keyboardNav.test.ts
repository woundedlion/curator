import { describe, expect, it } from "vitest";
import {
  computeKeyboardNavStep,
  deriveExtendEnd,
  isNavKey,
  type KeyboardNavInput,
} from "./keyboardNav";

const IDS = ["a", "b", "c", "d", "e", "f", "g", "h"];

function nav(overrides: Partial<KeyboardNavInput>): KeyboardNavInput {
  return {
    key: "ArrowDown",
    shift: false,
    visibleIds: IDS,
    cursor: null,
    anchor: null,
    pageSize: 3,
    ...overrides,
  };
}

describe("isNavKey", () => {
  it("matches the six navigation keys", () => {
    for (const key of [
      "ArrowUp",
      "ArrowDown",
      "Home",
      "End",
      "PageUp",
      "PageDown",
    ]) {
      expect(isNavKey(key)).toBe(true);
    }
  });
  it("rejects other keys", () => {
    expect(isNavKey("Enter")).toBe(false);
    expect(isNavKey("Tab")).toBe(false);
    expect(isNavKey("a")).toBe(false);
  });
});

describe("computeKeyboardNavStep — empty list", () => {
  it("returns null when no rows are visible", () => {
    expect(
      computeKeyboardNavStep(nav({ visibleIds: [], cursor: "a" })),
    ).toBeNull();
  });
});

describe("computeKeyboardNavStep — no cursor yet", () => {
  it("ArrowDown lands on the first row and single-selects it", () => {
    const step = computeKeyboardNavStep(nav({ key: "ArrowDown" }));
    expect(step).toEqual({
      selection: ["a"],
      anchor: "a",
      cursor: "a",
      cursorIndex: 0,
    });
  });

  it("ArrowUp also lands on the first row (no row above nothing)", () => {
    const step = computeKeyboardNavStep(nav({ key: "ArrowUp" }));
    expect(step?.cursor).toBe("a");
  });

  it("End jumps to last", () => {
    const step = computeKeyboardNavStep(nav({ key: "End" }));
    expect(step?.cursor).toBe("h");
    expect(step?.cursorIndex).toBe(7);
  });

  it("PageDown from no cursor lands on first row, not pageSize-1", () => {
    const step = computeKeyboardNavStep(nav({ key: "PageDown" }));
    expect(step?.cursor).toBe("a");
  });
});

describe("computeKeyboardNavStep — plain arrow (single-select)", () => {
  it("ArrowDown moves cursor +1 and resets anchor", () => {
    const step = computeKeyboardNavStep(
      nav({ key: "ArrowDown", cursor: "c", anchor: "a" }),
    );
    expect(step).toEqual({
      selection: ["d"],
      anchor: "d",
      cursor: "d",
      cursorIndex: 3,
    });
  });

  it("ArrowUp moves cursor -1", () => {
    const step = computeKeyboardNavStep(
      nav({ key: "ArrowUp", cursor: "c", anchor: "a" }),
    );
    expect(step?.cursor).toBe("b");
  });

  it("ArrowDown at the last row clamps", () => {
    const step = computeKeyboardNavStep(
      nav({ key: "ArrowDown", cursor: "h", anchor: "h" }),
    );
    expect(step?.cursor).toBe("h");
  });

  it("ArrowUp at the first row clamps", () => {
    const step = computeKeyboardNavStep(
      nav({ key: "ArrowUp", cursor: "a", anchor: "a" }),
    );
    expect(step?.cursor).toBe("a");
  });
});

describe("computeKeyboardNavStep — shift extend", () => {
  it("Shift+ArrowDown extends from anchor through new cursor", () => {
    const step = computeKeyboardNavStep(
      nav({
        key: "ArrowDown",
        shift: true,
        cursor: "c",
        anchor: "b",
      }),
    );
    // anchor=b, cursor=c → d. Range [b..d].
    expect(step?.selection).toEqual(["b", "c", "d"]);
    expect(step?.anchor).toBe("b");
    expect(step?.cursor).toBe("d");
  });

  it("Shift+ArrowUp shrinks the range when collapsing back toward anchor", () => {
    const step = computeKeyboardNavStep(
      nav({
        key: "ArrowUp",
        shift: true,
        cursor: "e",
        anchor: "b",
      }),
    );
    expect(step?.selection).toEqual(["b", "c", "d"]);
    expect(step?.anchor).toBe("b");
    expect(step?.cursor).toBe("d");
  });

  it("Shift+ArrowUp past the anchor flips the range direction", () => {
    const step = computeKeyboardNavStep(
      nav({
        key: "ArrowUp",
        shift: true,
        cursor: "c",
        anchor: "c",
      }),
    );
    expect(step?.selection).toEqual(["b", "c"]);
    expect(step?.anchor).toBe("c");
  });

  it("Shift+Arrow without a valid anchor falls back to single-select at the new cursor", () => {
    const step = computeKeyboardNavStep(
      nav({
        key: "ArrowDown",
        shift: true,
        cursor: "c",
        anchor: null,
      }),
    );
    expect(step?.selection).toEqual(["d"]);
    expect(step?.anchor).toBe("d");
  });

  it("Shift+Arrow with a stale (no-longer-visible) anchor falls back to the new cursor", () => {
    const step = computeKeyboardNavStep(
      nav({
        key: "ArrowDown",
        shift: true,
        cursor: "c",
        anchor: "zzz-deleted",
      }),
    );
    expect(step?.selection).toEqual(["d"]);
    expect(step?.anchor).toBe("d");
  });

  it("Shift+End extends to the last row", () => {
    const step = computeKeyboardNavStep(
      nav({
        key: "End",
        shift: true,
        cursor: "b",
        anchor: "b",
      }),
    );
    expect(step?.selection).toEqual(["b", "c", "d", "e", "f", "g", "h"]);
    expect(step?.cursor).toBe("h");
  });

  it("Shift+Home extends to the first row", () => {
    const step = computeKeyboardNavStep(
      nav({
        key: "Home",
        shift: true,
        cursor: "e",
        anchor: "e",
      }),
    );
    expect(step?.selection).toEqual(["a", "b", "c", "d", "e"]);
    expect(step?.cursor).toBe("a");
    expect(step?.anchor).toBe("e");
  });
});

describe("computeKeyboardNavStep — PageUp / PageDown", () => {
  it("PageDown advances by pageSize and clamps to last", () => {
    expect(
      computeKeyboardNavStep(
        nav({ key: "PageDown", cursor: "a", anchor: "a", pageSize: 3 }),
      )?.cursor,
    ).toBe("d");
    expect(
      computeKeyboardNavStep(
        nav({ key: "PageDown", cursor: "g", anchor: "g", pageSize: 3 }),
      )?.cursor,
    ).toBe("h");
  });

  it("PageUp retreats by pageSize and clamps to first", () => {
    expect(
      computeKeyboardNavStep(
        nav({ key: "PageUp", cursor: "h", anchor: "h", pageSize: 3 }),
      )?.cursor,
    ).toBe("e");
    expect(
      computeKeyboardNavStep(
        nav({ key: "PageUp", cursor: "b", anchor: "b", pageSize: 3 }),
      )?.cursor,
    ).toBe("a");
  });

  it("pageSize <= 0 is clamped to 1 so a zero-height container still steps", () => {
    const step = computeKeyboardNavStep(
      nav({ key: "PageDown", cursor: "a", anchor: "a", pageSize: 0 }),
    );
    expect(step?.cursor).toBe("b");
  });

  it("Shift+PageDown extends the range across the page step", () => {
    const step = computeKeyboardNavStep(
      nav({
        key: "PageDown",
        shift: true,
        cursor: "b",
        anchor: "b",
        pageSize: 3,
      }),
    );
    expect(step?.selection).toEqual(["b", "c", "d", "e"]);
    expect(step?.cursor).toBe("e");
    expect(step?.anchor).toBe("b");
  });
});

describe("deriveExtendEnd", () => {
  it("returns null for an empty selection", () => {
    expect(deriveExtendEnd(new Set(), "a", IDS)).toBeNull();
  });

  it("returns the anchor itself when only it is selected", () => {
    expect(deriveExtendEnd(new Set(["c"]), "c", IDS)).toBe("c");
  });

  it("returns the id furthest from anchor in visible order", () => {
    // sel={b,c,d}, anchor=b → end=d (furthest in same direction)
    expect(deriveExtendEnd(new Set(["b", "c", "d"]), "b", IDS)).toBe("d");
    // sel={c,d,e}, anchor=e → end=c
    expect(deriveExtendEnd(new Set(["c", "d", "e"]), "e", IDS)).toBe("c");
  });

  it("handles non-contiguous selections (Cmd+Click cases)", () => {
    // Click 5 (=e), Cmd+Click 1 (=a): anchor=a, sel={a,e} → end=e
    expect(deriveExtendEnd(new Set(["a", "e"]), "a", IDS)).toBe("e");
    // Click 1 (=a), Cmd+Click 5 (=e): anchor=e, sel={a,e} → end=a
    expect(deriveExtendEnd(new Set(["a", "e"]), "e", IDS)).toBe("a");
  });

  it("falls back to the first selected id when anchor is missing", () => {
    expect(deriveExtendEnd(new Set(["d", "f"]), null, IDS)).toBe("d");
  });

  it("falls back to the first selected id when anchor is no longer visible", () => {
    expect(deriveExtendEnd(new Set(["d", "f"]), "zzz", IDS)).toBe("d");
  });
});

