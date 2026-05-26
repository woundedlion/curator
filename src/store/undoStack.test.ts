import { describe, expect, it } from "vitest";
import {
  pushBounded,
  snapshotReorderEntry,
  snapshotReplaceEntry,
  type UndoEntry,
} from "./undoStack";
import type { Track } from "../types";

function buildAddEntry(n: number): UndoEntry {
  return { kind: "add", addedTrackIds: [`t${n}`] };
}

describe("pushBounded", () => {
  it("appends entries", () => {
    expect(pushBounded([], buildAddEntry(1))).toHaveLength(1);
  });

  it("caps at 10 entries", () => {
    let stack: UndoEntry[] = [];
    for (let i = 0; i < 15; i++) stack = pushBounded(stack, buildAddEntry(i));
    expect(stack).toHaveLength(10);
    expect(stack[0]).toEqual({ kind: "add", addedTrackIds: ["t5"] });
    expect(stack.at(-1)).toEqual({ kind: "add", addedTrackIds: ["t14"] });
  });
});

describe("snapshot helpers", () => {
  it("clones the trackIds array for reorder snapshots", () => {
    const ids = ["a", "b", "c"];
    const entry = snapshotReorderEntry(ids, {
      field: "artist",
      dir: "asc",
    });
    ids.push("d");
    if (entry.kind !== "reorder") throw new Error("expected reorder");
    expect(entry.priorTrackIds).toEqual(["a", "b", "c"]);
  });

  it("captures null sort spec for reorder snapshots", () => {
    const entry = snapshotReorderEntry(["a"], null);
    if (entry.kind !== "reorder") throw new Error("expected reorder");
    expect(entry.priorSort).toBeNull();
  });

  it("shallow-clones tracksById for replace snapshots", () => {
    const map: Record<string, Track> = {
      a: {
        id: "a",
        source: { kind: "text", rawLine: "a" },
        enrichment: { status: "idle" },
        spotify: { status: "idle" },
      },
    };
    const entry = snapshotReplaceEntry(["a"], map);
    if (entry.kind !== "replace") throw new Error("expected replace");
    expect(entry.priorTracksById).toEqual(map);
    expect(entry.priorTracksById).not.toBe(map);
  });
});
