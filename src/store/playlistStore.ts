import { create } from "zustand";
import { DRAFT_PLAYLIST_ID } from "../constants";
import { loadDraft, saveDraft } from "../db/draftRepository";
import { sortTrackIds } from "./sortComparator";
import {
  pushBounded,
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

  hydrateFromStorage: () => Promise<void>;
  addTracks: (tracks: Track[]) => void;
  updateTrack: (id: string, patch: Partial<Track>) => void;
  removeTrack: (id: string) => void;
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
  undo: () => void;
};

function buildEmptyPlaylist(): Playlist {
  return {
    id: DRAFT_PLAYLIST_ID,
    name: "New Playlist",
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
  if (entry.kind === "add") {
    const removed = new Set(entry.addedTrackIds);
    const nextById = { ...state.tracksById };
    for (const id of removed) delete nextById[id];
    return {
      tracksById: nextById,
      playlist: {
        ...state.playlist,
        trackIds: state.playlist.trackIds.filter((id) => !removed.has(id)),
      },
    };
  }
  if (entry.kind === "reorder") {
    return {
      playlist: {
        ...state.playlist,
        trackIds: [...entry.priorTrackIds],
        sort: entry.priorSort,
      },
    };
  }
  return {
    tracksById: { ...entry.priorTracksById },
    playlist: { ...state.playlist, trackIds: [...entry.priorTrackIds] },
  };
}

export const usePlaylistStore = create<PlaylistStore>((set) => ({
  playlist: buildEmptyPlaylist(),
  tracksById: {},
  undoStack: [],
  hydrated: false,

  async hydrateFromStorage() {
    const { playlist, tracks } = await loadDraft(DRAFT_PLAYLIST_ID);
    if (playlist) {
      const tracksById = buildTracksById(tracks);
      const liveTrackIds = playlist.trackIds.filter((id) => tracksById[id]);
      const recovered =
        liveTrackIds.length === playlist.trackIds.length
          ? playlist
          : { ...playlist, trackIds: liveTrackIds };
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
        undoStack: pushBounded(state.undoStack, {
          kind: "add",
          addedTrackIds: additions.map((t) => t.id),
        }),
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
    set((state) => {
      const nextById = { ...state.tracksById };
      delete nextById[id];
      return {
        tracksById: nextById,
        playlist: {
          ...state.playlist,
          trackIds: state.playlist.trackIds.filter((tid) => tid !== id),
        },
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
          snapshotReorderEntry(state.playlist.trackIds, state.playlist.sort),
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
          snapshotReorderEntry(state.playlist.trackIds, state.playlist.sort),
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
        snapshotReplaceEntry(state.playlist.trackIds, state.tracksById),
      ),
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
          snapshotReplaceEntry(state.playlist.trackIds, state.tracksById),
        ),
      };
    });
    schedulePersist();
  },

  undo() {
    set((state) => {
      if (state.undoStack.length === 0) return state;
      const entry = state.undoStack[state.undoStack.length - 1];
      const remaining = state.undoStack.slice(0, -1);
      return { ...applyUndo(state, entry), undoStack: remaining };
    });
    schedulePersist();
  },
}));
