// Verifies the ingestController routes File[] drops to the right
// downstream pipeline, surfaces parse failures as an aggregated toast,
// gates Spotify imports on a configured client_id, and refuses to
// overwrite playlist metadata when the draft has been touched.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// localStorage polyfill — touched indirectly by playlistStore (settings
// load) when the store module evaluates.
class MemoryStorage implements Storage {
  private store = new Map<string, string>();
  get length(): number {
    return this.store.size;
  }
  clear(): void {
    this.store.clear();
  }
  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }
  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null;
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
}
vi.stubGlobal("localStorage", new MemoryStorage());

const mocks = vi.hoisted(() => ({
  ingestFiles: vi.fn(),
  matchAllOnSpotify: vi.fn(async () => undefined),
  enrichAllPending: vi.fn(async () => undefined),
  fetchPlaylistTracks: vi.fn(),
  pushToast: vi.fn(),
}));

vi.mock("../ingest/ingestPipeline", () => ({
  ingestFiles: mocks.ingestFiles,
}));
vi.mock("./spotifyMatchRunner", () => ({
  matchAllOnSpotify: mocks.matchAllOnSpotify,
}));
vi.mock("./enrichmentRunner", () => ({
  enrichAllPending: mocks.enrichAllPending,
}));
vi.mock("../spotify/playlists", () => ({
  fetchPlaylistTracks: mocks.fetchPlaylistTracks,
}));

vi.mock("../store/uiStore", () => ({
  useUiStore: {
    getState: () => ({
      pushToast: mocks.pushToast,
      withBusy: async (fn: () => Promise<void>) => fn(),
    }),
  },
}));

import { DEFAULT_PLAYLIST_NAME } from "../constants";
import {
  ingestDroppedFiles,
  importPlaylistById,
} from "./ingestController";
import { usePlaylistStore } from "../store/playlistStore";
import { useSettingsStore } from "../store/settingsStore";
import type { Track } from "../types";

function makeTextFile(name: string, content: string): File {
  return new File([content], name, { type: "text/plain" });
}

function makeAudioFile(name: string): File {
  return new File([new Uint8Array([0])], name, { type: "audio/mpeg" });
}

function track(id: string, overrides: Partial<Track> = {}): Track {
  return {
    id,
    source: { kind: "file", fileName: `${id}.mp3` },
    title: `Title ${id}`,
    artist: `Artist ${id}`,
    spotify: { status: "idle" },
    enrichment: { status: "idle" },
    ...overrides,
  };
}

function resetStore(): void {
  usePlaylistStore.setState((state) => ({
    tracksById: {},
    selectedTrackIds: new Set<string>(),
    selectionAnchor: null,
    undoStack: [],
    playlist: {
      ...state.playlist,
      name: DEFAULT_PLAYLIST_NAME,
      description: "",
      public: false,
      collaborative: false,
      trackIds: [],
      sort: null,
      hideUnmatched: false,
    },
  }));
}

beforeEach(() => {
  resetStore();
  mocks.ingestFiles.mockReset();
  mocks.matchAllOnSpotify.mockReset();
  mocks.matchAllOnSpotify.mockResolvedValue(undefined);
  mocks.enrichAllPending.mockReset();
  mocks.enrichAllPending.mockResolvedValue(undefined);
  mocks.fetchPlaylistTracks.mockReset();
  mocks.pushToast.mockReset();
  useSettingsStore.setState((state) => ({
    ...state,
    settings: { ...state.settings, spotifyClientId: undefined },
  }));
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("ingestDroppedFiles", () => {
  it("does nothing useful on an empty drop", async () => {
    await ingestDroppedFiles([]);
    expect(mocks.ingestFiles).not.toHaveBeenCalled();
    expect(mocks.pushToast).not.toHaveBeenCalled();
    expect(usePlaylistStore.getState().playlist.trackIds).toHaveLength(0);
  });

  it("routes plain audio drops through ingestFiles and adds the parsed tracks", async () => {
    const audio = makeAudioFile("song.mp3");
    mocks.ingestFiles.mockResolvedValue({
      tracks: [track("a"), track("b")],
      failures: [],
    });

    await ingestDroppedFiles([audio]);

    expect(mocks.ingestFiles).toHaveBeenCalledTimes(1);
    expect(mocks.ingestFiles.mock.calls[0]![0]).toEqual([audio]);
    expect(usePlaylistStore.getState().playlist.trackIds).toEqual(["a", "b"]);
    expect(mocks.pushToast).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "success", message: "Added 2 tracks" }),
    );
  });

  it("surfaces per-file parse failures as a single aggregated error toast", async () => {
    mocks.ingestFiles.mockResolvedValue({
      tracks: [track("a")],
      failures: [
        { fileName: "broken1.mp3", error: new Error("bad header") },
        { fileName: "broken2.mp3", error: new Error("decode") },
      ],
    });

    await ingestDroppedFiles([makeAudioFile("a.mp3")]);

    const messages = mocks.pushToast.mock.calls.map((c) => c[0]);
    expect(messages).toContainEqual(
      expect.objectContaining({ kind: "success", message: "Added 1 tracks" }),
    );
    expect(messages).toContainEqual(
      expect.objectContaining({
        kind: "error",
        message: expect.stringMatching(/Skipped 2 files/),
      }),
    );
  });

  it("toasts 'no ingestible files' when nothing parses and nothing fails", async () => {
    mocks.ingestFiles.mockResolvedValue({ tracks: [], failures: [] });
    await ingestDroppedFiles([makeAudioFile("a.mp3")]);
    expect(mocks.pushToast).toHaveBeenCalledWith(
      expect.objectContaining({ message: "No ingestible files in drop" }),
    );
  });

  it("detects a Curator-export file by the format marker and restores meta on a pristine draft", async () => {
    const envelope = {
      format: "curator-playlist-v1" as const,
      name: "Roadtrip",
      description: "long drive",
      public: true,
      collaborative: false,
      tracks: [
        {
          title: "Song A",
          artist: "Band A",
          spotifyUri: "spotify:track:xyz",
        },
      ],
    };
    const file = makeTextFile("mix.curator.txt", JSON.stringify(envelope));

    await ingestDroppedFiles([file]);

    // ingestPipeline must NOT be touched for a curator-export file —
    // routing belongs to importEnvelope.
    expect(mocks.ingestFiles).not.toHaveBeenCalled();
    const state = usePlaylistStore.getState();
    expect(state.playlist.name).toBe("Roadtrip");
    expect(state.playlist.public).toBe(true);
    expect(state.playlist.trackIds).toHaveLength(1);
  });

  it("queues a SINGLE post-ingest sweep for a batch of N curator-export drops", async () => {
    // Regression: importing N envelopes previously queued N redundant
    // full match+enrich sweeps (one per envelope). The batch should
    // queue exactly one sweep after all envelopes are imported.
    const envelope = (name: string) => ({
      format: "curator-playlist-v1" as const,
      name,
      tracks: [{ title: `Song ${name}`, artist: `Artist ${name}` }],
    });
    const files = [
      makeTextFile("a.curator.txt", JSON.stringify(envelope("A"))),
      makeTextFile("b.curator.txt", JSON.stringify(envelope("B"))),
      makeTextFile("c.curator.txt", JSON.stringify(envelope("C"))),
    ];

    await ingestDroppedFiles(files);
    // Let the chained background runner promise settle.
    await Promise.resolve();
    await Promise.resolve();

    // All three envelopes' tracks landed...
    expect(usePlaylistStore.getState().playlist.trackIds).toHaveLength(3);
    // ...but the match+enrich runners ran exactly once for the whole batch.
    expect(mocks.matchAllOnSpotify).toHaveBeenCalledTimes(1);
    expect(mocks.enrichAllPending).toHaveBeenCalledTimes(1);
  });

  it("does NOT overwrite playlist meta when the draft already has tracks", async () => {
    // Seed the draft so it's no longer pristine.
    usePlaylistStore.setState((s) => ({
      ...s,
      tracksById: { existing: track("existing") },
      playlist: { ...s.playlist, name: "My Mix", trackIds: ["existing"] },
    }));

    const envelope = {
      format: "curator-playlist-v1" as const,
      name: "OverwriteMe",
      tracks: [{ title: "New", artist: "Imported" }],
    };
    await ingestDroppedFiles([
      makeTextFile("mix.curator.txt", JSON.stringify(envelope)),
    ]);

    const state = usePlaylistStore.getState();
    // Meta was preserved (the prior "My Mix" name should still be there).
    expect(state.playlist.name).toBe("My Mix");
    // But the tracks should be appended.
    expect(state.playlist.trackIds.length).toBe(2);
  });
});

describe("importPlaylistById", () => {
  it("refuses without a Spotify client id and surfaces a clear error", async () => {
    await importPlaylistById("playlist-1");
    expect(mocks.fetchPlaylistTracks).not.toHaveBeenCalled();
    expect(mocks.pushToast).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "error",
        message: expect.stringMatching(/Connect to Spotify/),
      }),
    );
  });

  it("appends Spotify-resolved tracks and toasts a count when the import succeeds", async () => {
    useSettingsStore.setState((s) => ({
      ...s,
      settings: { ...s.settings, spotifyClientId: "client-xyz" },
    }));
    mocks.fetchPlaylistTracks.mockResolvedValue([
      track("imp1", {
        spotify: {
          status: "matched",
          uri: "spotify:track:1",
          candidates: [],
          score: 1,
        },
      }),
      track("imp2", {
        spotify: {
          status: "matched",
          uri: "spotify:track:2",
          candidates: [],
          score: 1,
        },
      }),
    ]);

    await importPlaylistById("playlist-42");

    expect(mocks.fetchPlaylistTracks).toHaveBeenCalledWith(
      "playlist-42",
      "client-xyz",
    );
    expect(usePlaylistStore.getState().playlist.trackIds).toEqual([
      "imp1",
      "imp2",
    ]);
    expect(mocks.pushToast).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "success",
        message: expect.stringMatching(/Appended 2 tracks/),
      }),
    );
  });

  it("toasts a friendly message when the picked playlist has no tracks", async () => {
    useSettingsStore.setState((s) => ({
      ...s,
      settings: { ...s.settings, spotifyClientId: "client-xyz" },
    }));
    mocks.fetchPlaylistTracks.mockResolvedValue([]);

    await importPlaylistById("playlist-empty");

    expect(mocks.pushToast).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Playlist has no tracks" }),
    );
    expect(usePlaylistStore.getState().playlist.trackIds).toHaveLength(0);
  });
});
