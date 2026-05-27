import { describe, expect, it } from "vitest";
import {
  captureSelection,
  pushBounded,
  snapshotAddEntry,
  snapshotDeleteEntry,
  snapshotReorderEntry,
  snapshotReplaceEntry,
  type SelectionSnapshot,
  type UndoEntry,
} from "./undoStack";
import type { Track } from "../types";

const NO_SELECTION: SelectionSnapshot = { priorSelection: [], priorAnchor: null };

function buildAddEntry(n: number): UndoEntry {
  return snapshotAddEntry([`t${n}`], NO_SELECTION);
}

describe("pushBounded", () => {
  it("appends entries", () => {
    expect(pushBounded([], buildAddEntry(1))).toHaveLength(1);
  });

  it("caps at 10 entries", () => {
    let stack: UndoEntry[] = [];
    for (let i = 0; i < 15; i++) stack = pushBounded(stack, buildAddEntry(i));
    expect(stack).toHaveLength(10);
    expect(stack[0]).toMatchObject({ kind: "add", addedTrackIds: ["t5"] });
    expect(stack.at(-1)).toMatchObject({ kind: "add", addedTrackIds: ["t14"] });
  });

  it("preserves a stack at exactly MAX_UNDO_DEPTH without trimming early", () => {
    let stack: UndoEntry[] = [];
    for (let i = 0; i < 10; i++) stack = pushBounded(stack, buildAddEntry(i));
    expect(stack).toHaveLength(10);
    expect(stack[0]).toMatchObject({ kind: "add", addedTrackIds: ["t0"] });

    // 11th push trims the oldest, keeping length at 10.
    stack = pushBounded(stack, buildAddEntry(10));
    expect(stack).toHaveLength(10);
    expect(stack[0]).toMatchObject({ kind: "add", addedTrackIds: ["t1"] });
    expect(stack.at(-1)).toMatchObject({ kind: "add", addedTrackIds: ["t10"] });
  });
});

describe("captureSelection", () => {
  it("freezes the selection at call time", () => {
    const set = new Set(["a", "b"]);
    const snap = captureSelection(set, "a");
    set.add("c");
    expect(snap.priorSelection).toEqual(["a", "b"]);
    expect(snap.priorAnchor).toBe("a");
  });
});

describe("snapshot helpers", () => {
  it("clones the trackIds array for reorder snapshots", () => {
    const ids = ["a", "b", "c"];
    const entry = snapshotReorderEntry(
      ids,
      { field: "artist", dir: "asc" },
      NO_SELECTION,
    );
    ids.push("d");
    if (entry.kind !== "reorder") throw new Error("expected reorder");
    expect(entry.priorTrackIds).toEqual(["a", "b", "c"]);
  });

  it("captures null sort spec for reorder snapshots", () => {
    const entry = snapshotReorderEntry(["a"], null, NO_SELECTION);
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
    const entry = snapshotReplaceEntry(["a"], map, null, NO_SELECTION);
    if (entry.kind !== "replace") throw new Error("expected replace");
    expect(entry.priorTracksById).toEqual(map);
    expect(entry.priorTracksById).not.toBe(map);
  });

  it("captures the prior sort for replace snapshots so undo restores it", () => {
    const entry = snapshotReplaceEntry(
      ["a"],
      {},
      { field: "artist", dir: "desc" },
      NO_SELECTION,
    );
    if (entry.kind !== "replace") throw new Error("expected replace");
    expect(entry.priorSort).toEqual({ field: "artist", dir: "desc" });
  });

  it("captures full Track objects for delete snapshots", () => {
    const track: Track = {
      id: "a",
      source: { kind: "text", rawLine: "a" },
      title: "Karma Police",
      enrichment: { status: "matched", mbRecordingId: "mb-1" },
      spotify: { status: "matched", uri: "spotify:track:xyz" },
    };
    const priorIds = ["a", "b"];
    const entry = snapshotDeleteEntry(priorIds, [track], NO_SELECTION);
    if (entry.kind !== "delete") throw new Error("expected delete");
    priorIds.push("c");
    expect(entry.priorTrackIds).toEqual(["a", "b"]);
    expect(entry.deletedTracks[0]).toBe(track);
  });

  it("embeds the selection snapshot in every entry kind", () => {
    const sel = captureSelection(new Set(["a", "b"]), "a");
    expect(snapshotAddEntry(["x"], sel)).toMatchObject(sel);
    expect(snapshotReorderEntry(["a"], null, sel)).toMatchObject(sel);
    expect(snapshotReplaceEntry(["a"], {}, null, sel)).toMatchObject(sel);
    expect(snapshotDeleteEntry(["a"], [], sel)).toMatchObject(sel);
  });
});
