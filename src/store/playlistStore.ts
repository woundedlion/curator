import { create } from "zustand";
import { DEFAULT_PLAYLIST_NAME, DRAFT_PLAYLIST_ID } from "../constants";
import {
  DraftQuotaExceededError,
  loadDraft,
  saveDraft,
} from "../db/draftRepository";
import { cancelTrackRequests } from "../services/cancelTrackRequests";
import { useUiStore } from "./uiStore";
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

  // Track records are always replaced (never mutated in place) — every
  // store action that touches a Track writes `{ ...existing, ...patch }`
  // into a new tracksById entry. Other layers can rely on referential
  // identity to detect changes; the undo helpers depend on it for cheap
  // shallow copies.

  // Selection state. `selectedTrackIds` is the authoritative set for both
  // group-drag and bulk-delete. `selectionAnchorId` is the last id the user
  // affirmatively clicked (used as the origin for shift-extend). Selection
  // is transient — it never persists across sessions.
  selectedTrackIds: Set<string>;
  selectionAnchorId: string | null;

  hydrateFromStorage: () => Promise<void>;
  addTracks: (tracks: Track[]) => void;
  updateTrack: (id: string, patch: Partial<Track>) => void;
  // Atomic "fill missing displayed fields" — applies only to fields that are
  // currently `undefined` or `""` on the live track. Used by enrichment +
  // Spotify-match runners to honor the source-of-truth rule (user edit and
  // Spotify-selected values are never clobbered) even when the calling
  // closure is stale relative to an interleaving write.
  fillMissingDisplayFields: (
    id: string,
    fillIns: Partial<
      Pick<
        Track,
        | "title"
        | "artist"
        | "album"
        | "year"
        | "originalYear"
        | "durationMs"
        | "coverUrl"
      >
    >,
  ) => void;
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
  /**
   * Reset every track's Spotify + MusicBrainz state to `idle`,
   * cancelling any in-flight queue work first. Track identity
   * (title/artist/album/local file/etc.) is preserved — this is
   * NOT a clear; it's a "redo from scratch" gesture for the user
   * who wants every row re-searched without rebuilding the
   * playlist. Snapshots the prior state for undo.
   */
  nukeEnrichmentState: () => void;
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

// 250 ms coalesces bursts of store mutations (e.g. 100 enrichment
// completions in rapid succession) into a single IDB write while still
// flushing fast enough that a tab close ~immediately after the last
// edit catches the debounce — the pagehide/visibilitychange handlers
// in useAppBootstrap flush synchronously if the timer is still pending.
const PERSIST_DEBOUNCE_MS = 250;
let pendingPersistTimer: ReturnType<typeof setTimeout> | undefined;
// Persistence toasts can fire on every keystroke once writes are
// failing. Latch once per session per kind so the user sees the
// warning but isn't drowned in duplicates; the next reload resets the
// latches.
let quotaToastShown = false;
let genericPersistToastShown = false;

function reportPersistError(error: unknown): void {
  if (error instanceof DraftQuotaExceededError) {
    if (quotaToastShown) return;
    quotaToastShown = true;
    useUiStore.getState().pushToast({
      kind: "error",
      message:
        "Browser storage is full — draft can't be saved. Export to .curator.txt to preserve your work.",
    });
    return;
  }
  console.error("schedulePersist: persist failed", error);
  if (genericPersistToastShown) return;
  genericPersistToastShown = true;
  useUiStore.getState().pushToast({
    kind: "error",
    message:
      "Couldn't save draft to browser storage. Recent edits may be lost on reload — export to .curator.txt to preserve your work.",
  });
}

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
    void persistImmediately().catch(reportPersistError);
  }, PERSIST_DEBOUNCE_MS);
}

export async function flushPendingPersist(): Promise<void> {
  if (pendingPersistTimer) {
    clearTimeout(pendingPersistTimer);
    pendingPersistTimer = undefined;
  }
  try {
    await persistImmediately();
  } catch (error) {
    reportPersistError(error);
  }
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
    playlist: {
      ...state.playlist,
      trackIds: [...entry.priorTrackIds],
      sort: entry.priorSort,
    },
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

  fillMissingDisplayFields(id, fillIns) {
    set((state) => {
      const existing = state.tracksById[id];
      if (!existing) return state;
      const merged = mergeOnlyMissing(existing, fillIns);
      if (merged === existing) return state;
      return {
        tracksById: { ...state.tracksById, [id]: merged },
      };
    });
    schedulePersist();
  },

  removeTrack(id) {
    get().removeTracks([id]);
  },

  removeTracks(ids) {
    if (ids.length === 0) return;
    // Collect the ids that actually existed at delete time so we
    // only cancel for them. (Calling cancel for ids that were never
    // queued is harmless but logging the count would be misleading.)
    const actuallyRemoved: string[] = [];
    set((state) => {
      const removeSet = new Set(ids);
      const nextById = { ...state.tracksById };
      const deletedTracks: Track[] = [];
      for (const id of removeSet) {
        const existing = nextById[id];
        if (existing !== undefined) {
          deletedTracks.push(existing);
          actuallyRemoved.push(id);
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
    // Cancellation is a side effect — runs AFTER the store update so
    // the guard predicates (which check tracksById) see the post-
    // delete state. Calling it before set() would race with any
    // already-popped task that re-checks the store at run time.
    if (actuallyRemoved.length > 0) cancelTrackRequests(actuallyRemoved);
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
    // Capture the ids being displaced so we can cancel their queued
    // requests after the swap. The keep-set is anything also present
    // in the incoming tracks — those tracks survive the swap (their
    // payload is overwritten but the id continues to exist).
    let removedIds: string[] = [];
    set((state) => {
      const incoming = new Set(tracks.map((t) => t.id));
      removedIds = state.playlist.trackIds.filter((id) => !incoming.has(id));
      return {
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
            state.playlist.sort,
            captureSelection(state.selectedTrackIds, state.selectionAnchorId),
          ),
        ),
        selectedTrackIds: new Set<string>(),
        selectionAnchorId: null,
      };
    });
    if (removedIds.length > 0) cancelTrackRequests(removedIds);
    schedulePersist();
  },

  clearPlaylist() {
    // Clear is just replaceAll with an empty list — same undo shape
    // (snapshotReplaceEntry), same selection wipe, same cancellation
    // of every queued request. Delegating keeps the two paths from
    // drifting apart.
    if (get().playlist.trackIds.length === 0) return;
    get().replaceAll([]);
  },

  nukeEnrichmentState() {
    const state = get();
    if (state.playlist.trackIds.length === 0) return;
    const allIds = [...state.playlist.trackIds];

    // Cancel every queued request first. The store update below
    // resets statuses to idle; if we left in-flight tasks
    // un-cancelled they could land AFTER the reset and rewrite
    // some rows back to matched/missing mid-undo-window.
    cancelTrackRequests(allIds);

    set((s) => {
      const nextById: Record<string, Track> = {};
      for (const [id, t] of Object.entries(s.tracksById)) {
        nextById[id] = {
          ...t,
          spotify: { status: "idle" },
          enrichment: { status: "idle" },
        };
      }
      return {
        tracksById: nextById,
        // replace-style undo entry — restores prior tracksById in
        // full, which includes every row's prior spotify + MB state.
        undoStack: pushBounded(
          s.undoStack,
          snapshotReplaceEntry(
            s.playlist.trackIds,
            s.tracksById,
            s.playlist.sort,
            captureSelection(s.selectedTrackIds, s.selectionAnchorId),
          ),
        ),
      };
    });
    schedulePersist();
  },

  undo() {
    set((state) => {
      if (state.undoStack.length === 0) return state;
      const entry = state.undoStack[state.undoStack.length - 1]!;
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
      // If the stored anchor is no longer in the visible set (the filter
      // changed, or it was deleted), the anchor is stale and would
      // produce a range of just `[id]`. Reset it to `id` so subsequent
      // shift-clicks pivot off a meaningful origin.
      const anchorValid =
        state.selectionAnchorId !== null &&
        visibleIds.includes(state.selectionAnchorId);
      const effectiveAnchor = anchorValid ? state.selectionAnchorId : id;
      const range = rangeBetween(visibleIds, effectiveAnchor, id);
      return {
        selectedTrackIds: new Set(range),
        selectionAnchorId: effectiveAnchor,
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

function isFieldMissing(value: unknown): boolean {
  return value === undefined || value === null || value === "";
}

type FillableTrackFields = Pick<
  Track,
  | "title"
  | "artist"
  | "album"
  | "year"
  | "originalYear"
  | "durationMs"
  | "coverUrl"
>;

function mergeOnlyMissing(
  existing: Track,
  fillIns: Partial<FillableTrackFields>,
): Track {
  let changed = false;
  const merged: Track = { ...existing };
  for (const key of Object.keys(fillIns) as (keyof FillableTrackFields)[]) {
    const candidate = fillIns[key];
    if (candidate === undefined) continue;
    if (!isFieldMissing(existing[key])) continue;
    (merged[key] as FillableTrackFields[typeof key]) = candidate;
    changed = true;
  }
  return changed ? merged : existing;
}

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
