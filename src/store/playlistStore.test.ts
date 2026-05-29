import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// IndexedDB is not available in the test environment; the draft repository
// is the only side-effect we need to silence so the store-under-test stays
// pure. saveDraft is fire-and-forget through schedulePersist's debounce —
// stubbing it lets us assert in-memory state without touching IDB.
vi.mock("../db/draftRepository", () => ({
  saveDraft: vi.fn(async () => undefined),
  loadDraft: vi.fn(async () => ({ playlist: null, tracks: [] })),
}));

import { usePlaylistStore } from "./playlistStore";
import type { Track } from "../types";

function makeTrack(overrides: Partial<Track> = {}): Track {
  return {
    id: overrides.id ?? "t1",
    source: overrides.source ?? { kind: "file", fileName: "song.mp3" },
    enrichment: overrides.enrichment ?? { status: "idle" },
    spotify: overrides.spotify ?? { status: "idle" },
    ...overrides,
  };
}

function resetStore(): void {
  usePlaylistStore.setState({
    playlist: {
      id: "active-draft",
      name: "Test",
      description: "",
      public: false,
      collaborative: false,
      trackIds: [],
      sort: null,
      hideUnmatched: false,
    },
    tracksById: {},
    undoStack: [],
    selectedTrackIds: new Set<string>(),
    selectionAnchorId: null,
  });
}

beforeEach(() => {
  resetStore();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("fillMissingDisplayFields", () => {
  it("fills fields that are undefined", () => {
    const track = makeTrack({ id: "t1" });
    usePlaylistStore.getState().addTracks([track]);
    usePlaylistStore.getState().fillMissingDisplayFields("t1", {
      title: "Karma Police",
      artist: "Radiohead",
      year: 1997,
    });
    const result = usePlaylistStore.getState().tracksById["t1"]!;
    expect(result.title).toBe("Karma Police");
    expect(result.artist).toBe("Radiohead");
    expect(result.year).toBe(1997);
  });

  it("treats empty string as missing", () => {
    const track = makeTrack({ id: "t1", title: "" });
    usePlaylistStore.getState().addTracks([track]);
    usePlaylistStore.getState().fillMissingDisplayFields("t1", {
      title: "Filled",
    });
    expect(usePlaylistStore.getState().tracksById["t1"]!.title).toBe("Filled");
  });

  it("does not overwrite an existing user/Spotify value", () => {
    const track = makeTrack({
      id: "t1",
      title: "User's Title",
      artist: "User's Artist",
    });
    usePlaylistStore.getState().addTracks([track]);
    usePlaylistStore.getState().fillMissingDisplayFields("t1", {
      title: "MB title",
      artist: "MB artist",
      album: "MB album",
    });
    const result = usePlaylistStore.getState().tracksById["t1"]!;
    expect(result.title).toBe("User's Title");
    expect(result.artist).toBe("User's Artist");
    expect(result.album).toBe("MB album");
  });

  it("is a no-op when the track does not exist", () => {
    expect(() =>
      usePlaylistStore.getState().fillMissingDisplayFields("missing", {
        title: "X",
      }),
    ).not.toThrow();
  });

  it("does not change identity when nothing was missing", () => {
    const track = makeTrack({
      id: "t1",
      title: "T",
      artist: "A",
      album: "B",
      year: 2020,
    });
    usePlaylistStore.getState().addTracks([track]);
    const beforeIdentity = usePlaylistStore.getState().tracksById["t1"];
    usePlaylistStore.getState().fillMissingDisplayFields("t1", {
      title: "X",
      artist: "Y",
    });
    expect(usePlaylistStore.getState().tracksById["t1"]).toBe(beforeIdentity);
  });
});

describe("undo of clearPlaylist / replaceAll restores sort", () => {
  it("clearPlaylist + undo restores the prior sort", () => {
    const a = makeTrack({ id: "a", artist: "Aphex" });
    const b = makeTrack({ id: "b", artist: "Boards" });
    usePlaylistStore.getState().addTracks([a, b]);
    usePlaylistStore.getState().setSort("artist");
    const sortBefore = usePlaylistStore.getState().playlist.sort;
    expect(sortBefore).toEqual({ field: "artist", dir: "asc" });

    usePlaylistStore.getState().clearPlaylist();
    expect(usePlaylistStore.getState().playlist.sort).toBeNull();

    usePlaylistStore.getState().undo();
    expect(usePlaylistStore.getState().playlist.sort).toEqual({
      field: "artist",
      dir: "asc",
    });
    expect(usePlaylistStore.getState().playlist.trackIds.length).toBe(2);
  });

  it("replaceAll + undo restores the prior sort", () => {
    const a = makeTrack({ id: "a", artist: "Aphex" });
    const b = makeTrack({ id: "b", artist: "Boards" });
    usePlaylistStore.getState().addTracks([a, b]);
    usePlaylistStore.getState().setSort("artist");

    const c = makeTrack({ id: "c", artist: "Caribou" });
    usePlaylistStore.getState().replaceAll([c]);
    expect(usePlaylistStore.getState().playlist.sort).toBeNull();

    usePlaylistStore.getState().undo();
    expect(usePlaylistStore.getState().playlist.sort).toEqual({
      field: "artist",
      dir: "asc",
    });
  });
});

describe("source-of-truth invariant via fillMissingDisplayFields", () => {
  it("never overwrites a value set by a concurrent edit between snapshot and write", () => {
    // Simulates the stale-closure race the runners used to have: caller
    // snapshots the track when title is undefined, then a concurrent edit
    // sets title, then caller writes fill-ins back. The merge must see the
    // *fresh* state, not the snapshot.
    const track = makeTrack({ id: "race", title: undefined });
    usePlaylistStore.getState().addTracks([track]);

    // Concurrent edit — happens between the runner's snapshot and write:
    usePlaylistStore.getState().updateTrack("race", { title: "User typed" });

    // Runner's fill (would have overwritten under the old code):
    usePlaylistStore.getState().fillMissingDisplayFields("race", {
      title: "From MusicBrainz",
    });

    expect(usePlaylistStore.getState().tracksById["race"]!.title).toBe(
      "User typed",
    );
  });

  it("MB enrichment fields never overwrite Spotify-matched displayed fields", () => {
    // Models the README §source-of-truth rule 3: when a row is already
    // Spotify-matched, an MB enrichment landing later must not change
    // title/artist/album/year on display. fillMissingDisplayFields is
    // the only path enrichmentRunner writes through, and it refuses to
    // overwrite any non-empty value — so Spotify-set values survive.
    const track = makeTrack({
      id: "sp",
      title: "Spotify title",
      artist: "Spotify artist",
      album: "Spotify album",
      year: 2020,
      spotify: {
        status: "matched",
        uri: "spotify:track:abc",
        candidates: [],
        score: 1,
      },
    });
    usePlaylistStore.getState().addTracks([track]);

    usePlaylistStore.getState().fillMissingDisplayFields("sp", {
      title: "MB title",
      artist: "MB artist",
      album: "MB album",
      year: 1997,
      originalYear: 1995,
    });

    const result = usePlaylistStore.getState().tracksById["sp"]!;
    expect(result.title).toBe("Spotify title");
    expect(result.artist).toBe("Spotify artist");
    expect(result.album).toBe("Spotify album");
    expect(result.year).toBe(2020);
    // originalYear was undefined on the Spotify-matched track, so the
    // MB-provided value gets filled in — that's the documented
    // "supplementary" behavior.
    expect(result.originalYear).toBe(1995);
  });

  it("selection survives undo of a sort change", () => {
    const a = makeTrack({ id: "a", title: "Apple" });
    const b = makeTrack({ id: "b", title: "Banana" });
    usePlaylistStore.getState().addTracks([a, b]);
    usePlaylistStore.getState().setSelection(["a"], "a");

    usePlaylistStore.getState().setSort("title");
    usePlaylistStore.getState().undo();

    expect(Array.from(usePlaylistStore.getState().selectedTrackIds)).toEqual([
      "a",
    ]);
    expect(usePlaylistStore.getState().selectionAnchorId).toBe("a");
  });
});

describe("extendSelectionTo", () => {
  it("resets a stale anchor when it's no longer in visibleIds", () => {
    const a = makeTrack({ id: "a" });
    const b = makeTrack({ id: "b" });
    const c = makeTrack({ id: "c" });
    usePlaylistStore.getState().addTracks([a, b, c]);
    // Anchor on a track that's about to be filtered out.
    usePlaylistStore.getState().setSelection(["a"], "a");

    // Only b and c are visible (e.g. filter applied). Shift-click extends
    // to c. The stored anchor "a" is stale; the new effective anchor
    // should be c.
    usePlaylistStore.getState().extendSelectionTo("c", ["b", "c"]);

    expect(usePlaylistStore.getState().selectionAnchorId).toBe("c");
    expect(Array.from(usePlaylistStore.getState().selectedTrackIds)).toContain(
      "c",
    );
  });
});
