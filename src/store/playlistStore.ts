import { create } from "zustand";
import { DEFAULT_PLAYLIST_NAME, DRAFT_PLAYLIST_ID } from "../constants";
import { loadDraft, saveDraft } from "../db/draftRepository";
import { cancelTrackRequests } from "../services/cancelTrackRequests";
import { notifyPersistFailure } from "./persistNotifications";
import { rangeBetween } from "./selectionHelpers";
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

  // The trackId order captured the moment the playlist first leaves the
  // unsorted state, so a third (clearing) header click can restore the
  // user's manual arrangement instead of freezing the sorted order. Lives
  // in store state (not a module global) so it's mutated only via the pure
  // set-updaters that produce it — never written from inside a nominally-
  // pure updater as a side effect. Intentionally NOT persisted: it's
  // omitted from the IDB draft write (writeCurrentDraft saves `playlist` +
  // tracks only) and reset to null on hydrate, so a reload while a sort is
  // active keeps the sorted order — an acceptable corner versus threading
  // this through IDB and the undo stack. Reset to null whenever a fresh
  // manual order is established (reorder / move / replace / undo).
  preSortManualOrder: string[] | null;

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

function sameIdSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const setB = new Set(b);
  return a.every((id) => setB.has(id));
}

// Positional equality (order matters) — used by setSort's no-op guards to
// tell "this sort actually permuted the list" from "the list was already
// in this exact order".
function sameOrder(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((id, index) => id === b[index]);
}

async function writeCurrentDraft(): Promise<void> {
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

// Single-flight guard around the actual draft write. The debounce timer's
// trailing-edge persist and a pagehide/visibilitychange flush can both
// call persistImmediately while a save is already mid-`await`. Without
// this, two saveDraft calls run concurrently against the same draft id;
// the repository serializes the writes internally, but relying on that
// for correctness is fragile and the concurrent path double-writes. We
// keep at most one save in flight and, if any caller asks again while it
// runs, re-run once afterward against a fresh snapshot — so the final
// write reflects the latest state exactly once.
let activePersist: Promise<void> | null = null;
let persistRequestedDuringFlight = false;

async function persistImmediately(): Promise<void> {
  if (activePersist) {
    persistRequestedDuringFlight = true;
    return activePersist;
  }
  activePersist = (async () => {
    try {
      do {
        persistRequestedDuringFlight = false;
        await writeCurrentDraft();
      } while (persistRequestedDuringFlight);
    } finally {
      activePersist = null;
    }
  })();
  return activePersist;
}

function schedulePersist(): void {
  if (pendingPersistTimer) clearTimeout(pendingPersistTimer);
  pendingPersistTimer = setTimeout(() => {
    pendingPersistTimer = undefined;
    void persistImmediately().catch(notifyPersistFailure);
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
    notifyPersistFailure(error);
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
    // Note the asymmetry with reorder/replace entries: delete does NOT
    // restore `sort` (the entry doesn't snapshot it) because removeTracks
    // never changes sort — deleting rows leaves the active sort spec intact.
    // If a future edit ever lets a delete touch sort, add priorSort to the
    // delete entry (undoStack.ts) and restore it here.
    const nextById = { ...state.tracksById };
    for (const track of entry.deletedTracks) nextById[track.id] = track;
    return {
      tracksById: nextById,
      playlist: { ...state.playlist, trackIds: [...entry.priorTrackIds] },
      ...restoreSelection(new Set(entry.priorTrackIds)),
    };
  }
  if (entry.kind === "replace") {
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
  // Exhaustiveness: a new UndoEntry kind must add its own branch above
  // rather than silently inheriting the replace shape.
  return assertNeverUndoEntry(entry);
}

function assertNeverUndoEntry(entry: never): never {
  throw new Error(
    `applyUndo: unhandled UndoEntry kind: ${String((entry as { kind?: unknown }).kind)}`,
  );
}

export const usePlaylistStore = create<PlaylistStore>((set, get) => {
  // Run `updater` and report whether it actually changed state (returned
  // a value other than the input `state`). Lets actions skip a redundant
  // debounced persist on a genuine no-op — chiefly fillMissingDisplayFields
  // hitting an already-filled row during an enrichment burst, the hot path
  // the original unconditional schedulePersist() defeated the debounce on.
  const mutate = (
    updater: (state: PlaylistStore) => PlaylistStore | Partial<PlaylistStore>,
  ): boolean => {
    let changed = false;
    set((state) => {
      const result = updater(state);
      if (result === state) return state;
      changed = true;
      return result;
    });
    return changed;
  };

  return {
  playlist: buildEmptyPlaylist(),
  tracksById: {},
  undoStack: [],
  hydrated: false,
  preSortManualOrder: null,
  selectedTrackIds: new Set<string>(),
  selectionAnchorId: null,

  async hydrateFromStorage() {
    // Hydration swaps in a logically-different playlist; any pre-sort
    // manual order captured against the previous session's playlist is
    // now stale and must not leak into this one's sort-clear restore — so
    // both set() paths below reset preSortManualOrder to null.
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
      set({
        playlist: recovered,
        tracksById,
        hydrated: true,
        preSortManualOrder: null,
      });
      // Flush the repaired playlist so the orphaned trackIds don't linger
      // on disk until the next user mutation (they'd re-surface as the
      // same `dropped` warning on every reload until then).
      if (dropped > 0) schedulePersist();
    } else {
      set({ hydrated: true, preSortManualOrder: null });
    }
  },

  addTracks(tracks) {
    const changed = mutate((state) => {
      // Dedup against existing tracks AND within the incoming batch: two
      // entries sharing an id would otherwise both pass the existing-id
      // filter (neither is in tracksById yet), pushing a duplicate id into
      // trackIds while only one survives in tracksById.
      const seen = new Set<string>();
      const additions = tracks.filter((t) => {
        if (state.tracksById[t.id] || seen.has(t.id)) return false;
        seen.add(t.id);
        return true;
      });
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
    if (changed) schedulePersist();
  },

  updateTrack(id, patch) {
    const changed = mutate((state) => {
      const existing = state.tracksById[id];
      if (!existing) return state;
      return {
        tracksById: { ...state.tracksById, [id]: { ...existing, ...patch } },
      };
    });
    if (changed) schedulePersist();
  },

  fillMissingDisplayFields(id, fillIns) {
    const changed = mutate((state) => {
      const existing = state.tracksById[id];
      if (!existing) return state;
      const merged = mergeOnlyMissing(existing, fillIns);
      if (merged === existing) return state;
      return {
        tracksById: { ...state.tracksById, [id]: merged },
      };
    });
    if (changed) schedulePersist();
  },

  removeTrack(id) {
    get().removeTracks([id]);
  },

  removeTracks(ids) {
    if (ids.length === 0) return;
    // Collect the ids that actually existed at delete time so we only
    // cancel for them. (Calling cancel for ids that were never queued is
    // harmless but logging the count would be misleading.) Computed from
    // the live store via get() OUTSIDE the set() updater so the updater
    // stays pure — never smuggling values out via closure mutation. The
    // updater below recomputes the same existence check on `state`, so a
    // concurrent write between this read and the commit can only narrow
    // (never widen) what's deleted; cancellation only ever targets ids the
    // updater actually removed.
    const before = get().tracksById;
    const removeSet = new Set(ids);
    const actuallyRemoved: string[] = [];
    for (const id of removeSet) {
      if (before[id] !== undefined) actuallyRemoved.push(id);
    }
    if (actuallyRemoved.length === 0) return;
    set((state) => {
      // Detect which ids actually exist BEFORE cloning tracksById, so a
      // no-op delete (e.g. removeTrack on an already-gone id) returns
      // `state` without an O(n) full-map copy.
      const deletedTracks: Track[] = [];
      // Snapshot order here is the remove-set iteration order (caller
      // order), NOT playlist order — it is non-canonical. Undo reconstructs
      // row positions from `priorTrackIds`, never from this array's order,
      // so the ordering is intentionally not preserved here. A future edit
      // that relies on deletedTracks being in playlist order must sort it.
      for (const id of removeSet) {
        const existing = state.tracksById[id];
        if (existing !== undefined) {
          deletedTracks.push(existing);
        }
      }
      if (deletedTracks.length === 0) return state;
      const nextById = { ...state.tracksById };
      for (const track of deletedTracks) delete nextById[track.id];
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
    // (actuallyRemoved is non-empty here: the early return above bailed
    // when nothing existed to delete.)
    cancelTrackRequests(actuallyRemoved);
    schedulePersist();
  },

  reorderTracks(orderedIds) {
    const changed = mutate((state) => {
      // Integrity guard: orderedIds must be a permutation of the current
      // trackIds. A caller passing a wrong, missing, or extra id would
      // otherwise write trackIds out of sync with tracksById — orphaning
      // rows (filtered only lazily at persist time) and silently dropping
      // tracks. Reject a non-permutation as a no-op rather than corrupt
      // the store. (This is the only mutating action that takes a caller-
      // supplied id list verbatim; every other path derives ids from the
      // tracks themselves.)
      if (!sameIdSet(orderedIds, state.playlist.trackIds)) {
        console.warn(
          "reorderTracks: ignoring orderedIds that is not a permutation of current trackIds",
        );
        return state;
      }
      const noChange = orderedIds.every(
        (id, index) => id === state.playlist.trackIds[index],
      );
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
        // A manual reorder IS the new manual order — any captured pre-sort
        // order is now stale.
        preSortManualOrder: null,
      };
    });
    if (changed) schedulePersist();
  },

  setSort(field) {
    const changed = mutate((state) => {
      const current = state.playlist.sort;
      const next = cycleSortDirection(current?.field, current?.dir, field);
      const priorSnapshot = snapshotReorderEntry(
        state.playlist.trackIds,
        state.playlist.sort,
        captureSelection(state.selectedTrackIds, state.selectionAnchorId),
      );
      // Leaving the unsorted state for the first time: remember the
      // manual order so the clearing (third) click can restore it.
      // Otherwise carry the existing capture forward unchanged. Computed
      // as a value here (not a side-effect write) so the updater stays
      // pure — the returned state object is what commits the capture.
      const nextManualOrder =
        !current && next.field
          ? [...state.playlist.trackIds]
          : state.preSortManualOrder;
      if (!next.field || !next.dir) {
        // Clearing the sort. Restore the captured manual order when it
        // still covers exactly the current id set (no track was added or
        // removed mid-sort); otherwise keep the current order so nothing
        // is lost.
        const restored =
          state.preSortManualOrder &&
          sameIdSet(state.preSortManualOrder, state.playlist.trackIds)
            ? [...state.preSortManualOrder]
            : state.playlist.trackIds;
        // True no-op guard: clearing a sort that's already null AND that
        // wouldn't reorder anything mustn't push an undo entry or persist
        // (e.g. cycling a never-sorted column back to cleared). We compare
        // the resulting order + sort against the prior state.
        if (!current && sameOrder(restored, state.playlist.trackIds)) {
          return state;
        }
        return {
          playlist: { ...state.playlist, trackIds: restored, sort: null },
          undoStack: pushBounded(state.undoStack, priorSnapshot),
          preSortManualOrder: null,
        };
      }
      // Index by the live Record directly — no full Map materialization.
      // sortTrackIds only ever reads via `.get`, so a thin adapter over
      // the existing tracksById avoids an O(n) Object.entries + Map copy
      // on every header click.
      const orderedIds = sortTrackIds(
        state.playlist.trackIds,
        { get: (id) => state.tracksById[id] },
        next.field,
        next.dir,
      );
      // No-op guard: applying a sort that leaves both the order AND the
      // sort spec identical (e.g. re-sorting an already-sorted column in
      // the same direction) must not pollute the undo stack or trigger a
      // redundant IDB write.
      if (
        sameOrder(orderedIds, state.playlist.trackIds) &&
        current?.field === next.field &&
        current?.dir === next.dir
      ) {
        return state;
      }
      return {
        playlist: {
          ...state.playlist,
          trackIds: orderedIds,
          sort: { field: next.field, dir: next.dir },
        },
        undoStack: pushBounded(state.undoStack, priorSnapshot),
        preSortManualOrder: nextManualOrder,
      };
    });
    if (changed) schedulePersist();
  },

  clearSort() {
    const changed = mutate((state) => {
      if (!state.playlist.sort) return state;
      // Mirror setSort's clearing branch: put the manual order back if we
      // still have a faithful capture of it.
      const restored =
        state.preSortManualOrder &&
        sameIdSet(state.preSortManualOrder, state.playlist.trackIds)
          ? [...state.preSortManualOrder]
          : state.playlist.trackIds;
      return {
        playlist: { ...state.playlist, trackIds: restored, sort: null },
        undoStack: pushBounded(
          state.undoStack,
          snapshotReorderEntry(
            state.playlist.trackIds,
            state.playlist.sort,
            captureSelection(state.selectedTrackIds, state.selectionAnchorId),
          ),
        ),
        preSortManualOrder: null,
      };
    });
    if (changed) schedulePersist();
  },

  setHideUnmatched(hide) {
    const changed = mutate((state) => {
      // Skip the new-object allocation + persist when the flag is already
      // set to the requested value (e.g. a toggle handler firing twice).
      if (state.playlist.hideUnmatched === hide) return state;
      return { playlist: { ...state.playlist, hideUnmatched: hide } };
    });
    if (changed) schedulePersist();
  },

  setPlaylistMeta(patch) {
    const changed = mutate((state) => {
      // Skip when every patched field already equals its current value —
      // metadata edits that don't actually change anything (e.g. blurring
      // an unedited name field) shouldn't trigger an IDB write.
      const noChange = (
        Object.keys(patch) as (keyof typeof patch)[]
      ).every((key) => state.playlist[key] === patch[key]);
      if (noChange) return state;
      return { playlist: { ...state.playlist, ...patch } };
    });
    if (changed) schedulePersist();
  },

  replaceAll(tracks) {
    // Replacing an empty list with an empty list is a no-op — don't push
    // a useless `replace` undo entry or schedule a redundant persist.
    // (A non-empty → empty replace IS meaningful: it's the destructive
    // Spotify "replace import" path and must remain undoable.)
    if (tracks.length === 0 && get().playlist.trackIds.length === 0) return;
    // Capture the ids being displaced so we can cancel their queued requests
    // after the swap. The keep-set is anything also present in the incoming
    // tracks — those tracks survive the swap (their payload is overwritten
    // but the id continues to exist). Computed from the live store via get()
    // OUTSIDE the updater so the updater stays pure (no closure mutation);
    // the early-return guard above already proved this call mutates state.
    const incoming = new Set(tracks.map((t) => t.id));
    const removedIds = get().playlist.trackIds.filter(
      (id) => !incoming.has(id),
    );
    const changed = mutate((state) => ({
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
      // A wholesale replace establishes a brand-new manual order.
      preSortManualOrder: null,
    }));
    if (removedIds.length > 0) cancelTrackRequests(removedIds);
    if (changed) schedulePersist();
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
    // No-op when every row is already idle: nuking changes nothing, but
    // the unconditional path would push the heaviest possible undo entry
    // (a full tracksById clone) and schedule a persist for zero effect —
    // common right after a fresh all-idle import.
    const allIdle = state.playlist.trackIds.every((id) => {
      const t = state.tracksById[id];
      return (
        t === undefined ||
        (t.spotify.status === "idle" && t.enrichment.status === "idle")
      );
    });
    if (allIdle) return;
    const allIds = [...state.playlist.trackIds];

    // Cancel every queued request first. The store update below
    // resets statuses to idle; if we left in-flight tasks
    // un-cancelled they could land AFTER the reset and rewrite
    // some rows back to matched/missing mid-undo-window.
    cancelTrackRequests(allIds);

    const changed = mutate((s) => {
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
    if (changed) schedulePersist();
  },

  undo() {
    const changed = mutate((state) => {
      if (state.undoStack.length === 0) return state;
      const entry = state.undoStack[state.undoStack.length - 1]!;
      const remaining = state.undoStack.slice(0, -1);
      // applyUndo restores the prior selection from the entry itself —
      // we don't blanket-clear selection any more.
      return {
        ...applyUndo(state, entry),
        undoStack: remaining,
        // An undo can restore an arbitrary prior order; any captured
        // pre-sort order no longer reflects reality.
        preSortManualOrder: null,
      };
    });
    if (changed) schedulePersist();
  },

  selectOnly(id) {
    set((state) => {
      // No-op guard: re-selecting the already-sole selection would allocate
      // a fresh Set and re-render every subscriber for no state change.
      if (
        state.selectedTrackIds.size === 1 &&
        state.selectedTrackIds.has(id) &&
        state.selectionAnchorId === id
      ) {
        return state;
      }
      return {
        selectedTrackIds: new Set([id]),
        selectionAnchorId: id,
      };
    });
  },

  toggleSelection(id) {
    set((state) => {
      const next = new Set(state.selectedTrackIds);
      const wasSelected = next.has(id);
      if (wasSelected) next.delete(id);
      else next.add(id);
      // Anchor follows ADDs but NOT REMOVEs — a ctrl-click that
      // deselects didn't affirmatively pivot to the row, it removed
      // it. Leaving the anchor at the toggled-off id would make a
      // subsequent shift-click extend from a row that's no longer in
      // the selection (file-explorer-style behaviour). If the anchor
      // *was* the toggled-off id, clear it so the next shift-click
      // sets a fresh anchor at its own click point.
      let nextAnchor: string | null;
      if (wasSelected) {
        nextAnchor =
          state.selectionAnchorId === id ? null : state.selectionAnchorId;
      } else {
        nextAnchor = id;
      }
      return { selectedTrackIds: next, selectionAnchorId: nextAnchor };
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
    set((state) => {
      const nextAnchor = anchorId ?? null;
      const nextSet = new Set(ids);
      // No-op guard: skip the store update (and the subscriber re-render it
      // triggers) when the set and anchor are unchanged. The rubber-band
      // hook already dedups, so this is defense-in-depth for other callers.
      if (
        state.selectionAnchorId === nextAnchor &&
        setsEqual(nextSet, state.selectedTrackIds)
      ) {
        return state;
      }
      return { selectedTrackIds: nextSet, selectionAnchorId: nextAnchor };
    });
  },

  addToSelection(ids) {
    set((state) => {
      const current = state.selectedTrackIds;
      let anyNew = false;
      for (const id of ids) {
        if (!current.has(id)) {
          anyNew = true;
          break;
        }
      }
      if (!anyNew) return state;
      const next = new Set(current);
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
  };
});

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
    // Skip candidates that are themselves "missing" (undefined/null/"")
    // using the SAME predicate as the existing-side check — a null/empty
    // fill-in must not overwrite an already-missing field, which would
    // churn row identity for no display gain.
    if (isFieldMissing(candidate)) continue;
    if (!isFieldMissing(existing[key])) continue;
    (merged[key] as FillableTrackFields[typeof key]) = candidate;
    changed = true;
  }
  return changed ? merged : existing;
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
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
