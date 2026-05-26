import type { SortSpec, Track } from "../types";

const MAX_UNDO_DEPTH = 10;

export type UndoEntry =
  | { kind: "add"; addedTrackIds: string[] }
  | {
      kind: "replace";
      priorTrackIds: string[];
      priorTracksById: Record<string, Track>;
    }
  | {
      kind: "reorder";
      priorTrackIds: string[];
      priorSort: SortSpec;
    };

export function pushBounded(stack: UndoEntry[], entry: UndoEntry): UndoEntry[] {
  const next = [...stack, entry];
  if (next.length <= MAX_UNDO_DEPTH) return next;
  return next.slice(next.length - MAX_UNDO_DEPTH);
}

export function snapshotReplaceEntry(
  priorTrackIds: string[],
  priorTracksById: Record<string, Track>,
): UndoEntry {
  return {
    kind: "replace",
    priorTrackIds: [...priorTrackIds],
    priorTracksById: { ...priorTracksById },
  };
}

export function snapshotReorderEntry(
  priorTrackIds: string[],
  priorSort: SortSpec,
): UndoEntry {
  return {
    kind: "reorder",
    priorTrackIds: [...priorTrackIds],
    priorSort: priorSort ? { ...priorSort } : null,
  };
}
