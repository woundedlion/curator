import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// IndexedDB is not available in the test environment; the draft repository
// is the only side-effect we need to silence so the store-under-test stays
// pure. saveDraft is fire-and-forget through schedulePersist's debounce —
// stubbing it lets us assert in-memory state without touching IDB.
vi.mock("../db/draftRepository", () => ({
  saveDraft: vi.fn(async () => undefined),
  loadDraft: vi.fn(async () => ({ playlist: null, tracks: [] })),
}));

// cancelTrackRequests is mocked so the cancellation-ordering tests can
// assert (a) WHICH ids were cancelled and (b) that the store snapshot
// the cancel observed already reflects the post-delete state (the
// runner's defense-in-depth guards check tracksById; calling cancel
// before set() would race the guards into seeing the pre-delete map).
vi.mock("../services/cancelTrackRequests", () => ({
  cancelTrackRequests: vi.fn(),
}));

import { usePlaylistStore } from "./playlistStore";
import { saveDraft } from "../db/draftRepository";
import { cancelTrackRequests } from "../services/cancelTrackRequests";
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
  vi.mocked(saveDraft).mockClear();
  vi.mocked(cancelTrackRequests).mockClear();
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

// ─── schedulePersist debouncing ─────────────────────────────────────
//
// The store debounces saves at PERSIST_DEBOUNCE_MS (250 ms). A
// 100-event burst (e.g. an enrichment pass writing matched status to
// every row) must coalesce into a single IDB write, otherwise a cold
// import re-serializes the entire playlist 100 times back-to-back.
// schedulePersist is private — we observe it through the saveDraft
// mock.

describe("schedulePersist debounce", () => {
  it("coalesces a burst of mutations into a single saveDraft after 250ms", async () => {
    vi.useFakeTimers();
    const a = makeTrack({ id: "a" });
    const b = makeTrack({ id: "b" });
    const c = makeTrack({ id: "c" });
    usePlaylistStore.getState().addTracks([a, b, c]);
    // addTracks itself called schedulePersist. Pile on more mutations
    // inside the debounce window — every one resets the timer.
    usePlaylistStore.getState().updateTrack("a", { title: "A1" });
    usePlaylistStore.getState().updateTrack("a", { title: "A2" });
    usePlaylistStore.getState().updateTrack("b", { title: "B1" });
    expect(saveDraft).not.toHaveBeenCalled();
    // Advance just before the debounce fires — still no save.
    await vi.advanceTimersByTimeAsync(249);
    expect(saveDraft).not.toHaveBeenCalled();
    // Cross the debounce boundary.
    await vi.advanceTimersByTimeAsync(2);
    expect(saveDraft).toHaveBeenCalledTimes(1);
  });

  it("rapid successive schedulePersist calls do NOT each fire their own save", async () => {
    vi.useFakeTimers();
    const t = makeTrack({ id: "t" });
    usePlaylistStore.getState().addTracks([t]);
    // 10 rapid mutations within the window.
    for (let i = 0; i < 10; i++) {
      usePlaylistStore.getState().updateTrack("t", { title: `v${i}` });
      await vi.advanceTimersByTimeAsync(10);
    }
    // Total elapsed: 100ms — still inside the 250ms window from the
    // LAST mutation (the timer was reset on each call). No save yet.
    expect(saveDraft).not.toHaveBeenCalled();
    // Now drain the debounce window from the last mutation.
    await vi.advanceTimersByTimeAsync(250);
    expect(saveDraft).toHaveBeenCalledTimes(1);
    // The persisted snapshot reflects the LAST value, not any
    // intermediate one — coalescing without loss of correctness.
    const [, savedTracks] = vi.mocked(saveDraft).mock.calls[0]!;
    expect(savedTracks).toHaveLength(1);
    expect(savedTracks[0]!.title).toBe("v9");
  });
});

// ─── nukeEnrichmentState ────────────────────────────────────────────
//
// The toolbar's "redo everything from scratch" action. Resets every
// row's spotify + enrichment back to `idle` while preserving track
// identity (title/artist/album/local file/etc.). The undo restores the
// full prior tracksById. Cancellation of every queued task happens
// FIRST so a re-enrich pass kicked off after the nuke doesn't race
// stale in-flight responses into the freshly-reset rows.

describe("nukeEnrichmentState", () => {
  it("resets every track's spotify AND enrichment status to idle", () => {
    const a = makeTrack({
      id: "a",
      title: "A",
      spotify: {
        status: "matched",
        uri: "spotify:track:a",
        candidates: [],
        score: 0.9,
      },
      enrichment: {
        status: "matched",
        mbRecordingId: "rid-a",
        candidates: [],
        score: 0.95,
      },
    });
    const b = makeTrack({
      id: "b",
      title: "B",
      spotify: { status: "missing" },
      enrichment: { status: "failed" },
    });
    usePlaylistStore.getState().addTracks([a, b]);

    usePlaylistStore.getState().nukeEnrichmentState();

    const post = usePlaylistStore.getState().tracksById;
    expect(post["a"]!.spotify.status).toBe("idle");
    expect(post["a"]!.enrichment.status).toBe("idle");
    expect(post["b"]!.spotify.status).toBe("idle");
    expect(post["b"]!.enrichment.status).toBe("idle");
    // Identity is preserved — this is "redo enrichment" not "clear".
    expect(post["a"]!.title).toBe("A");
    expect(post["b"]!.title).toBe("B");
  });

  it("cancels queued tasks for every track BEFORE the store update", () => {
    // The cancel must observe the OLD tracksById (rows still present
    // with their statuses) — otherwise a freshly-popped task whose
    // guard re-checks the store would see "row exists, status pending,
    // proceed" and fire an HTTP call that lands into the reset state.
    // We assert ordering by observing the store state from inside the
    // cancel mock.
    const a = makeTrack({ id: "a" });
    const b = makeTrack({ id: "b" });
    usePlaylistStore.getState().addTracks([a, b]);

    let cancelObservedTracksById: Record<string, Track> | undefined;
    vi.mocked(cancelTrackRequests).mockImplementationOnce(() => {
      cancelObservedTracksById = usePlaylistStore.getState().tracksById;
    });

    usePlaylistStore.getState().nukeEnrichmentState();

    expect(cancelTrackRequests).toHaveBeenCalledWith(["a", "b"]);
    // From inside the cancel callback, the rows are STILL present
    // (their identity survives the nuke); we verify the cancel saw the
    // PRE-nuke statuses, not the post-nuke idle statuses, by checking
    // that the recorded reference is the one before the nuke's set()
    // committed.
    expect(cancelObservedTracksById).toBeDefined();
    expect(Object.keys(cancelObservedTracksById!).sort()).toEqual(["a", "b"]);
  });

  it("snapshots the full prior tracksById onto the undo stack", () => {
    const a = makeTrack({
      id: "a",
      title: "A",
      spotify: {
        status: "matched",
        uri: "spotify:track:a",
        candidates: [],
        score: 0.9,
      },
      enrichment: {
        status: "matched",
        mbRecordingId: "rid-a",
        candidates: [],
        score: 0.95,
      },
    });
    usePlaylistStore.getState().addTracks([a]);

    usePlaylistStore.getState().nukeEnrichmentState();
    // Mid-state: nuked.
    expect(
      usePlaylistStore.getState().tracksById["a"]!.spotify.status,
    ).toBe("idle");
    expect(
      usePlaylistStore.getState().tracksById["a"]!.enrichment.status,
    ).toBe("idle");

    usePlaylistStore.getState().undo();

    // Restored — the entry was a "replace" entry carrying the full
    // prior tracksById, so every status comes back.
    const restored = usePlaylistStore.getState().tracksById["a"]!;
    expect(restored.spotify.status).toBe("matched");
    expect(restored.enrichment.status).toBe("matched");
  });

  it("is a no-op on an empty playlist (no cancel, no undo entry)", () => {
    usePlaylistStore.getState().nukeEnrichmentState();
    expect(cancelTrackRequests).not.toHaveBeenCalled();
    expect(usePlaylistStore.getState().undoStack).toHaveLength(0);
  });
});

// ─── removeTracks cancellation ordering ─────────────────────────────
//
// The store's contract: cancellation runs AFTER set() so a queued
// task whose `guard` re-checks `tracksById[id]` at run-time sees the
// post-delete map ("track gone → bail"). Calling cancel before set()
// would race: pop-and-guard between cancel and set would see the
// PRE-delete map, pass the guard, and fire a doomed HTTP call.

describe("removeTracks cancellation ordering", () => {
  it("cancelTrackRequests is invoked AFTER the store update, with the deleted ids", () => {
    const a = makeTrack({ id: "a" });
    const b = makeTrack({ id: "b" });
    const c = makeTrack({ id: "c" });
    usePlaylistStore.getState().addTracks([a, b, c]);

    let observedTracksById: Record<string, Track> | undefined;
    vi.mocked(cancelTrackRequests).mockImplementationOnce(() => {
      observedTracksById = usePlaylistStore.getState().tracksById;
    });

    usePlaylistStore.getState().removeTracks(["a", "c"]);

    expect(cancelTrackRequests).toHaveBeenCalledWith(["a", "c"]);
    // The mock observed the post-delete tracksById — exactly what the
    // queue-guard contract requires.
    expect(observedTracksById).toBeDefined();
    expect(Object.keys(observedTracksById!).sort()).toEqual(["b"]);
  });

  it("an empty input is a complete no-op (no set, no cancel)", () => {
    const a = makeTrack({ id: "a" });
    usePlaylistStore.getState().addTracks([a]);
    const before = usePlaylistStore.getState().tracksById;
    vi.mocked(cancelTrackRequests).mockClear();

    usePlaylistStore.getState().removeTracks([]);

    expect(cancelTrackRequests).not.toHaveBeenCalled();
    expect(usePlaylistStore.getState().tracksById).toBe(before);
  });

  it("ids that don't exist in the playlist are filtered out before cancellation", () => {
    const a = makeTrack({ id: "a" });
    usePlaylistStore.getState().addTracks([a]);
    vi.mocked(cancelTrackRequests).mockClear();

    usePlaylistStore.getState().removeTracks(["a", "ghost", "phantom"]);

    // Only the id that was actually removed is forwarded to the
    // cancel side effect — the unknown ids would be tag-lookups that
    // never match anything, wasted work.
    expect(cancelTrackRequests).toHaveBeenCalledWith(["a"]);
  });
});

describe("toggleSelection anchor semantics", () => {
  it("moves anchor to the clicked id when the toggle ADDS to selection", () => {
    const a = makeTrack({ id: "a" });
    const b = makeTrack({ id: "b" });
    usePlaylistStore.getState().addTracks([a, b]);
    usePlaylistStore.getState().setSelection(["a"], "a");

    usePlaylistStore.getState().toggleSelection("b");

    expect(usePlaylistStore.getState().selectionAnchorId).toBe("b");
    expect(Array.from(usePlaylistStore.getState().selectedTrackIds).sort()).toEqual([
      "a",
      "b",
    ]);
  });

  it("does NOT move anchor when the toggle REMOVES from selection (regression)", () => {
    // Before the fix, every toggle wrote `selectionAnchorId = id`,
    // even when the row was deselected. A subsequent shift-click
    // would then extend from a row the user just removed.
    const a = makeTrack({ id: "a" });
    const b = makeTrack({ id: "b" });
    const c = makeTrack({ id: "c" });
    usePlaylistStore.getState().addTracks([a, b, c]);
    // Selection {a, b, c}, anchor a (set by the original click on a).
    usePlaylistStore.getState().setSelection(["a", "b", "c"], "a");

    // Ctrl-click c to deselect.
    usePlaylistStore.getState().toggleSelection("c");

    expect(Array.from(usePlaylistStore.getState().selectedTrackIds).sort()).toEqual([
      "a",
      "b",
    ]);
    expect(usePlaylistStore.getState().selectionAnchorId).toBe("a");
  });

  it("clears anchor when the toggle removes the row that WAS the anchor", () => {
    const a = makeTrack({ id: "a" });
    const b = makeTrack({ id: "b" });
    usePlaylistStore.getState().addTracks([a, b]);
    // Anchor IS the row being toggled off.
    usePlaylistStore.getState().setSelection(["a", "b"], "b");

    usePlaylistStore.getState().toggleSelection("b");

    expect(Array.from(usePlaylistStore.getState().selectedTrackIds)).toEqual(["a"]);
    // No meaningful pivot remains — next shift-click should establish
    // a fresh anchor at its own click point (extendSelectionTo
    // handles `anchor === null` by treating the new id as the anchor).
    expect(usePlaylistStore.getState().selectionAnchorId).toBeNull();
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
