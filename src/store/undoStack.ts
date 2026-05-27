import type { SortSpec, Track } from "../types";

const MAX_UNDO_DEPTH = 10;

// Every undo entry carries the selection that was active at the time the
// entry was pushed. Restoring selection on undo means the user's selection
// state survives an accidental delete/reorder/clear — they can pick up
// exactly where they left off instead of losing the selection along with
// whatever action triggered the undo.
export type SelectionSnapshot = {
  priorSelection: string[];
  priorAnchor: string | null;
};

export type UndoEntry =
  | ({ kind: "add"; addedTrackIds: string[] } & SelectionSnapshot)
  | ({
      kind: "replace";
      priorTrackIds: string[];
      priorTracksById: Record<string, Track>;
      priorSort: SortSpec;
    } & SelectionSnapshot)
  | ({
      kind: "reorder";
      priorTrackIds: string[];
      priorSort: SortSpec;
    } & SelectionSnapshot)
  | ({
      // Restoring deleted tracks: we keep the full Track objects (so cover
      // art, enrichment state, etc. come back exactly as they were) plus
      // the prior trackIds order so each row lands back at its old index.
      kind: "delete";
      priorTrackIds: string[];
      deletedTracks: Track[];
    } & SelectionSnapshot);

export function pushBounded(stack: UndoEntry[], entry: UndoEntry): UndoEntry[] {
  const next = [...stack, entry];
  if (next.length <= MAX_UNDO_DEPTH) return next;
  return next.slice(next.length - MAX_UNDO_DEPTH);
}

export function captureSelection(
  selectedTrackIds: ReadonlySet<string>,
  selectionAnchorId: string | null,
): SelectionSnapshot {
  return {
    priorSelection: Array.from(selectedTrackIds),
    priorAnchor: selectionAnchorId,
  };
}

export function snapshotReplaceEntry(
  priorTrackIds: string[],
  priorTracksById: Record<string, Track>,
  priorSort: SortSpec,
  selection: SelectionSnapshot,
): UndoEntry {
  return {
    kind: "replace",
    priorTrackIds: [...priorTrackIds],
    priorTracksById: { ...priorTracksById },
    priorSort: priorSort ? { ...priorSort } : null,
    ...selection,
  };
}

export function snapshotReorderEntry(
  priorTrackIds: string[],
  priorSort: SortSpec,
  selection: SelectionSnapshot,
): UndoEntry {
  return {
    kind: "reorder",
    priorTrackIds: [...priorTrackIds],
    priorSort: priorSort ? { ...priorSort } : null,
    ...selection,
  };
}

export function snapshotDeleteEntry(
  priorTrackIds: string[],
  deletedTracks: Track[],
  selection: SelectionSnapshot,
): UndoEntry {
  return {
    kind: "delete",
    priorTrackIds: [...priorTrackIds],
    // Tracks are replaced (not mutated) on update — every updateTrack
    // writes `{ ...existing, ...patch }` — so a shallow array copy is
    // enough to freeze the reference set at delete time.
    deletedTracks: [...deletedTracks],
    ...selection,
  };
}

export function snapshotAddEntry(
  addedTrackIds: string[],
  selection: SelectionSnapshot,
): UndoEntry {
  return {
    kind: "add",
    addedTrackIds: [...addedTrackIds],
    ...selection,
  };
}
