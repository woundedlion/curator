import { create } from "zustand";
import { DEFAULT_PLAYLIST_NAME, DRAFT_PLAYLIST_ID } from "../constants";
import { loadDraft, saveDraft } from "../db/draftRepository";
import {
  moveSelectionBlock,
  moveSelectionBlockToEnd,
  rangeBetween,
} from "./selectionHelpers";
import { sortTrackIds } from "./sortComparator";
import {
  captureSelection,
  pushBounded,
  snapshotAddEntry,
  snapshotDeleteEntry,
  snapshotReorderEntry,
  snapshotReplaceEntry,
  type UndoEntry,
} from "./undoStack";
import type { Playlist, SortField, Track } from "../types";

type PlaylistStore = {
  playlist: Playlist;
  tracksById: Record<string, Track>;
  undoStack: UndoEntry[];
  hydrated: boolean;

  // Selection state. `selectedTrackIds` is the authoritative set for both
  // group-drag and bulk-delete. `selectionAnchorId` is the last id the user
  // affirmatively clicked (used as the origin for shift-extend). Selection
  // is transient — it never persists across sessions.
  selectedTrackIds: Set<string>;
  selectionAnchorId: string | null;

  hydrateFromStorage: () => Promise<void>;
  addTracks: (tracks: Track[]) => void;
  updateTrack: (id: string, patch: Partial<Track>) => void;
  removeTrack: (id: string) => void;
  removeTracks: (ids: string[]) => void;
  reorderTracks: (orderedIds: string[]) => void;
  moveSelectionTo: (
    targetId: string | "end",
    movingIds?: ReadonlyArray<string>,
  ) => void;
  setSort: (field: SortField) => void;
  clearSort: () => void;
  setHideUnmatched: (hide: boolean) => void;
  setPlaylistMeta: (
    patch: Partial<
      Pick<Playlist, "name" | "description" | "public" | "collaborative">
    >,
  ) => void;
  replaceAll: (tracks: Track[]) => void;
  clearPlaylist: () => void;
  undo: () => void;

  // Selection actions.
  selectOnly: (id: string) => void;
  toggleSelection: (id: string) => void;
  extendSelectionTo: (id: string, visibleIds: string[]) => void;
  setSelection: (ids: Iterable<string>, anchorId?: string | null) => void;
  addToSelection: (ids: Iterable<string>) => void;
  clearSelection: () => void;
};

function buildEmptyPlaylist(): Playlist {
  return {
    id: DRAFT_PLAYLIST_ID,
    name: DEFAULT_PLAYLIST_NAME,
    description: "",
    public: false,
    collaborative: false,
    trackIds: [],
    sort: null,
    hideUnmatched: false,
  };
}

function buildTracksById(tracks: Track[]): Record<string, Track> {
  const map: Record<string, Track> = {};
  for (const track of tracks) map[track.id] = track;
  return map;
}

function cycleSortDirection(
  currentField: SortField | undefined,
  currentDir: "asc" | "desc" | undefined,
  clickedField: SortField,
): { field?: SortField; dir?: "asc" | "desc" } {
  if (currentField !== clickedField) return { field: clickedField, dir: "asc" };
  if (currentDir === "asc") return { field: clickedField, dir: "desc" };
  return {};
}

const PERSIST_DEBOUNCE_MS = 250;
let pendingPersistTimer: ReturnType<typeof setTimeout> | undefined;

async function persistImmediately(): Promise<void> {
  const state = usePlaylistStore.getState();
  const tracks: Track[] = [];
  const liveTrackIds: string[] = [];
  for (const id of state.playlist.trackIds) {
    const track = state.tracksById[id];
    if (track === undefined) continue;
    tracks.push(track);
    liveTrackIds.push(id);
  }
  const playlistToSave =
    liveTrackIds.length === state.playlist.trackIds.length
      ? state.playlist
      : { ...state.playlist, trackIds: liveTrackIds };
  await saveDraft(playlistToSave, tracks);
}

function schedulePersist(): void {
  if (pendingPersistTimer) clearTimeout(pendingPersistTimer);
  pendingPersistTimer = setTimeout(() => {
    pendingPersistTimer = undefined;
    void persistImmediately().catch((error) => {
      console.error("schedulePersist: persist failed", error);
    });
  }, PERSIST_DEBOUNCE_MS);
}

export async function flushPendingPersist(): Promise<void> {
  if (pendingPersistTimer) {
    clearTimeout(pendingPersistTimer);
    pendingPersistTimer = undefined;
  }
  await persistImmediately();
}

function applyUndo(
  state: PlaylistStore,
  entry: UndoEntry,
): Partial<PlaylistStore> {
  // Every undo entry carries the selection that was active when it was
  // pushed. Restoring it here keeps the user's working context intact —
  // an accidental delete-and-undo lands them right back on the same
  // selection they had a moment ago. We only drop ids that no longer
  // exist after the revert (e.g. after undoing an add).
  const restoreSelection = (validIds: Set<string>) => {
    const restored = entry.priorSelection.filter((id) => validIds.has(id));
    const anchor =
      entry.priorAnchor !== null && validIds.has(entry.priorAnchor)
        ? entry.priorAnchor
        : null;
    return {
      selectedTrackIds: new Set(restored),
      selectionAnchorId: anchor,
    };
  };

  if (entry.kind === "add") {
    const removed = new Set(entry.addedTrackIds);
    const nextById = { ...state.tracksById };
    for (const id of removed) delete nextById[id];
    const nextIds = state.playlist.trackIds.filter((id) => !removed.has(id));
    return {
      tracksById: nextById,
      playlist: { ...state.playlist, trackIds: nextIds },
      ...restoreSelection(new Set(nextIds)),
    };
  }
  if (entry.kind === "reorder") {
    return {
      playlist: {
        ...state.playlist,
        trackIds: [...entry.priorTrackIds],
        sort: entry.priorSort,
      },
      ...restoreSelection(new Set(entry.priorTrackIds)),
    };
  }
  if (entry.kind === "delete") {
    // Restore only the deleted tracks; other tracks may have been mutated
    // (e.g. enrichment updates) since the delete and shouldn't be reverted.
    const nextById = { ...state.tracksById };
    for (const track of entry.deletedTracks) nextById[track.id] = track;
    return {
      tracksById: nextById,
      playlist: { ...state.playlist, trackIds: [...entry.priorTrackIds] },
      ...restoreSelection(new Set(entry.priorTrackIds)),
    };
  }
  return {
    tracksById: { ...entry.priorTracksById },
    playlist: { ...state.playlist, trackIds: [...entry.priorTrackIds] },
    ...restoreSelection(new Set(entry.priorTrackIds)),
  };
}

export const usePlaylistStore = create<PlaylistStore>((set, get) => ({
  playlist: buildEmptyPlaylist(),
  tracksById: {},
  undoStack: [],
  hydrated: false,
  selectedTrackIds: new Set<string>(),
  selectionAnchorId: null,

  async hydrateFromStorage() {
    const { playlist, tracks } = await loadDraft(DRAFT_PLAYLIST_ID);
    if (playlist) {
      const tracksById = buildTracksById(tracks);
      const liveTrackIds = playlist.trackIds.filter((id) => tracksById[id]);
      const dropped = playlist.trackIds.length - liveTrackIds.length;
      if (dropped > 0) {
        const droppedIds = playlist.trackIds.filter((id) => !tracksById[id]);
        console.warn(
          `hydrateFromStorage: dropped ${dropped} trackId(s) with no track payload`,
          droppedIds,
        );
      }
      const recovered =
        dropped === 0 ? playlist : { ...playlist, trackIds: liveTrackIds };
      set({ playlist: recovered, tracksById, hydrated: true });
    } else {
      set({ hydrated: true });
    }
  },

  addTracks(tracks) {
    set((state) => {
      const additions = tracks.filter((t) => !state.tracksById[t.id]);
      if (additions.length === 0) return state;
      const nextById = { ...state.tracksById };
      for (const track of additions) nextById[track.id] = track;
      return {
        tracksById: nextById,
        playlist: {
          ...state.playlist,
          trackIds: [...state.playlist.trackIds, ...additions.map((t) => t.id)],
        },
        undoStack: pushBounded(
          state.undoStack,
          snapshotAddEntry(
            additions.map((t) => t.id),
            captureSelection(state.selectedTrackIds, state.selectionAnchorId),
          ),
        ),
      };
    });
    schedulePersist();
  },

  updateTrack(id, patch) {
    set((state) => {
      const existing = state.tracksById[id];
      if (!existing) return state;
      return {
        tracksById: { ...state.tracksById, [id]: { ...existing, ...patch } },
      };
    });
    schedulePersist();
  },

  removeTrack(id) {
    get().removeTracks([id]);
  },

  removeTracks(ids) {
    if (ids.length === 0) return;
    set((state) => {
      const removeSet = new Set(ids);
      const nextById = { ...state.tracksById };
      const deletedTracks: Track[] = [];
      for (const id of removeSet) {
        const existing = nextById[id];
        if (existing !== undefined) {
          deletedTracks.push(existing);
          delete nextById[id];
        }
      }
      if (deletedTracks.length === 0) return state;
      const nextSelection = pruneSelection(state.selectedTrackIds, removeSet);
      const nextAnchor =
        state.selectionAnchorId && removeSet.has(state.selectionAnchorId)
          ? null
          : state.selectionAnchorId;
      return {
        tracksById: nextById,
        playlist: {
          ...state.playlist,
          trackIds: state.playlist.trackIds.filter(
            (tid) => !removeSet.has(tid),
          ),
        },
        selectedTrackIds: nextSelection,
        selectionAnchorId: nextAnchor,
        undoStack: pushBounded(
          state.undoStack,
          snapshotDeleteEntry(
            state.playlist.trackIds,
            deletedTracks,
            captureSelection(state.selectedTrackIds, state.selectionAnchorId),
          ),
        ),
      };
    });
    schedulePersist();
  },

  reorderTracks(orderedIds) {
    set((state) => {
      const noChange =
        orderedIds.length === state.playlist.trackIds.length &&
        orderedIds.every((id, index) => id === state.playlist.trackIds[index]);
      if (noChange) return state;
      return {
        playlist: { ...state.playlist, trackIds: orderedIds, sort: null },
        undoStack: pushBounded(
          state.undoStack,
          snapshotReorderEntry(
            state.playlist.trackIds,
            state.playlist.sort,
            captureSelection(state.selectedTrackIds, state.selectionAnchorId),
          ),
        ),
      };
    });
    schedulePersist();
  },

  moveSelectionTo(targetId, movingIds) {
    set((state) => {
      const moving =
        movingIds && movingIds.length > 0
          ? new Set(movingIds)
          : state.selectedTrackIds;
      if (moving.size === 0) return state;
      const nextIds =
        targetId === "end"
          ? moveSelectionBlockToEnd(state.playlist.trackIds, moving)
          : moveSelectionBlock(state.playlist.trackIds, moving, targetId);
      if (nextIds === state.playlist.trackIds) return state;
      return {
        playlist: { ...state.playlist, trackIds: nextIds, sort: null },
        undoStack: pushBounded(
          state.undoStack,
          snapshotReorderEntry(
            state.playlist.trackIds,
            state.playlist.sort,
            captureSelection(state.selectedTrackIds, state.selectionAnchorId),
          ),
        ),
      };
    });
    schedulePersist();
  },

  setSort(field) {
    set((state) => {
      const current = state.playlist.sort;
      const next = cycleSortDirection(current?.field, current?.dir, field);
      const priorSnapshot = snapshotReorderEntry(
        state.playlist.trackIds,
        state.playlist.sort,
        captureSelection(state.selectedTrackIds, state.selectionAnchorId),
      );
      if (!next.field || !next.dir) {
        return {
          playlist: { ...state.playlist, sort: null },
          undoStack: pushBounded(state.undoStack, priorSnapshot),
        };
      }
      const tracksMap = new Map(Object.entries(state.tracksById));
      const orderedIds = sortTrackIds(
        state.playlist.trackIds,
        tracksMap,
        next.field,
        next.dir,
      );
      return {
        playlist: {
          ...state.playlist,
          trackIds: orderedIds,
          sort: { field: next.field, dir: next.dir },
        },
        undoStack: pushBounded(state.undoStack, priorSnapshot),
      };
    });
    schedulePersist();
  },

  clearSort() {
    set((state) => {
      if (!state.playlist.sort) return state;
      return {
        playlist: { ...state.playlist, sort: null },
        undoStack: pushBounded(
          state.undoStack,
          snapshotReorderEntry(
            state.playlist.trackIds,
            state.playlist.sort,
            captureSelection(state.selectedTrackIds, state.selectionAnchorId),
          ),
        ),
      };
    });
    schedulePersist();
  },

  setHideUnmatched(hide) {
    set((state) => ({ playlist: { ...state.playlist, hideUnmatched: hide } }));
    schedulePersist();
  },

  setPlaylistMeta(patch) {
    set((state) => ({ playlist: { ...state.playlist, ...patch } }));
    schedulePersist();
  },

  replaceAll(tracks) {
    set((state) => ({
      tracksById: buildTracksById(tracks),
      playlist: {
        ...state.playlist,
        trackIds: tracks.map((t) => t.id),
        sort: null,
      },
      undoStack: pushBounded(
        state.undoStack,
        snapshotReplaceEntry(
          state.playlist.trackIds,
          state.tracksById,
          captureSelection(state.selectedTrackIds, state.selectionAnchorId),
        ),
      ),
      selectedTrackIds: new Set<string>(),
      selectionAnchorId: null,
    }));
    schedulePersist();
  },

  clearPlaylist() {
    set((state) => {
      if (state.playlist.trackIds.length === 0) return state;
      return {
        tracksById: {},
        playlist: { ...state.playlist, trackIds: [], sort: null },
        undoStack: pushBounded(
          state.undoStack,
          snapshotReplaceEntry(
            state.playlist.trackIds,
            state.tracksById,
            captureSelection(state.selectedTrackIds, state.selectionAnchorId),
          ),
        ),
        selectedTrackIds: new Set<string>(),
        selectionAnchorId: null,
      };
    });
    schedulePersist();
  },

  undo() {
    set((state) => {
      if (state.undoStack.length === 0) return state;
      const entry = state.undoStack[state.undoStack.length - 1];
      const remaining = state.undoStack.slice(0, -1);
      // applyUndo restores the prior selection from the entry itself —
      // we don't blanket-clear selection any more.
      return {
        ...applyUndo(state, entry),
        undoStack: remaining,
      };
    });
    schedulePersist();
  },

  selectOnly(id) {
    set({
      selectedTrackIds: new Set([id]),
      selectionAnchorId: id,
    });
  },

  toggleSelection(id) {
    set((state) => {
      const next = new Set(state.selectedTrackIds);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { selectedTrackIds: next, selectionAnchorId: id };
    });
  },

  extendSelectionTo(id, visibleIds) {
    set((state) => {
      const range = rangeBetween(visibleIds, state.selectionAnchorId, id);
      return {
        selectedTrackIds: new Set(range),
        // Anchor stays put so subsequent shift-clicks pivot off the same
        // origin (matches file-explorer behavior).
        selectionAnchorId: state.selectionAnchorId ?? id,
      };
    });
  },

  setSelection(ids, anchorId) {
    set({
      selectedTrackIds: new Set(ids),
      selectionAnchorId: anchorId ?? null,
    });
  },

  addToSelection(ids) {
    set((state) => {
      const next = new Set(state.selectedTrackIds);
      for (const id of ids) next.add(id);
      return { selectedTrackIds: next };
    });
  },

  clearSelection() {
    set((state) => {
      if (state.selectedTrackIds.size === 0 && state.selectionAnchorId === null)
        return state;
      return {
        selectedTrackIds: new Set<string>(),
        selectionAnchorId: null,
      };
    });
  },
}));

function pruneSelection(
  selection: Set<string>,
  removed: Set<string>,
): Set<string> {
  if (selection.size === 0) return selection;
  let needsCopy = false;
  for (const id of selection) {
    if (removed.has(id)) {
      needsCopy = true;
      break;
    }
  }
  if (!needsCopy) return selection;
  const next = new Set<string>();
  for (const id of selection) if (!removed.has(id)) next.add(id);
  return next;
}
