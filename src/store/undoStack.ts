import type { SortSpec, Track } from "../types";

const MAX_UNDO_DEPTH = 10;

// Undo entries can sit on the stack for the life of the session (depth 10).
// A Track's `localFile` is a `File` blob; retaining it by reference would
// pin that blob un-GC-able for as long as the entry lives, multiplied across
// every snapshotted track. Undo restore does NOT need the blob: re-added
// rows reappear with all display/enrichment state intact, and the playback
// layer (createPlaybackSource) tolerates a missing localFile — it simply
// falls through to a Spotify SDK/preview/external source. The trade-off is
// bounded and deliberate: a deleted-then-undone local-only track loses its
// in-app local-file playback (it can be re-ingested by re-dropping the file)
// in exchange for not leaking blobs. We strip ONLY in the undo snapshot,
// never in the live store. The persist path strips localFile too
// (draftRepository.trackWithoutFile), so this mirrors what already happens
// on reload.
function stripLocalFile(track: Track): Track {
  if (track.localFile === undefined) return track;
  const copy = { ...track };
  delete copy.localFile;
  return copy;
}

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
      // Restoring deleted tracks: we keep the Track objects (so cover art,
      // enrichment state, etc. come back exactly as they were) minus their
      // localFile blob (stripped to avoid pinning Files — see
      // stripLocalFile) plus the prior trackIds order so each row lands back
      // at its old index.
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
  const strippedById: Record<string, Track> = {};
  for (const [id, track] of Object.entries(priorTracksById)) {
    strippedById[id] = stripLocalFile(track);
  }
  return {
    kind: "replace",
    priorTrackIds: [...priorTrackIds],
    // localFile blobs are stripped from the snapshot — see stripLocalFile.
    priorTracksById: strippedById,
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
    // writes `{ ...existing, ...patch }` — so a shallow per-track copy is
    // enough to freeze the reference set at delete time. We additionally
    // strip localFile from each (see stripLocalFile) so undo entries don't
    // pin File blobs in memory.
    deletedTracks: deletedTracks.map(stripLocalFile),
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
