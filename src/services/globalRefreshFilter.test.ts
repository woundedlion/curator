// Verifies that global refresh (the toolbar's ↻ "re-enrich all" action)
// AND the post-ingest match+enrich runners ONLY queue requests for
// items that are still "unknown" — never re-fire against tracks that
// have already been resolved to matched / ambiguous / missing on
// Spotify, or matched / ambiguous / failed on MusicBrainz.
//
// The user-facing contract this protects:
//   - Clicking "Re-enrich all" on a 500-track playlist where 480 are
//     resolved must only queue ~20 requests, not 500. Otherwise every
//     click of the toolbar button burns the Spotify rate-limit budget
//     re-asking about settled rows.
//   - A re-enrich pass after a partial network failure should pick up
//     ONLY the rows that didn't resolve, not the ones that did.
//
// We mock `searchSpotifyForTrack` and the MB enrichment service so the
// tests can count exactly which trackIds were processed, without
// going through the full HTTP stack.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// localStorage polyfill — apiClient.ts reads from it at module init.
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

vi.mock("../store/uiStore", () => ({
  useUiStore: {
    getState: () => ({
      pushToast: () => undefined,
      withBusy: async (fn: () => Promise<void>) => fn(),
    }),
  },
}));

// vi.mock factories are hoisted to the top of the file, so any
// variables they reference must be declared via vi.hoisted to live in
// the same hoisted scope.
const mocks = vi.hoisted(() => ({
  searchSpotifyForTrack: vi.fn(),
  enrichTrack: vi.fn(),
  deleteCachedCandidates: vi.fn(async () => undefined),
  probeCoverArtUrl: vi.fn(async () => ({ kind: "missing" as const })),
}));

vi.mock("../spotify/spotifySearch", () => ({
  searchSpotifyForTrack: mocks.searchSpotifyForTrack,
}));
vi.mock("../enrichment/enrichmentService", () => ({
  enrichTrack: mocks.enrichTrack,
}));
vi.mock("../db/musicbrainzCache", () => ({
  deleteCachedCandidates: mocks.deleteCachedCandidates,
}));
vi.mock("../enrichment/coverArt", () => ({
  probeCoverArtUrl: mocks.probeCoverArtUrl,
}));

const { searchSpotifyForTrack, enrichTrack } = mocks;

import { reenrichAll } from "./enrichmentRunner";
import { matchAllOnSpotify } from "./spotifyMatchRunner";
import { usePlaylistStore } from "../store/playlistStore";
import { useSettingsStore } from "../store/settingsStore";
import type { Enrichment, SpotifyMatch, Track } from "../types";

function spotifyStateFor(
  id: string,
  status: "idle" | "pending" | "matched" | "ambiguous" | "missing",
): SpotifyMatch {
  switch (status) {
    case "idle":
    case "pending":
    case "missing":
      return { status };
    case "matched":
      return {
        status: "matched",
        uri: `spotify:track:${id}`,
        candidates: [],
        score: 1,
      };
    case "ambiguous":
      return { status: "ambiguous", candidates: [], score: 0.5 };
  }
}

function enrichmentStateFor(
  status: "idle" | "pending" | "matched" | "ambiguous" | "failed",
  userOverride: boolean | undefined,
): Enrichment {
  switch (status) {
    case "idle":
    case "pending":
      return { status, userOverride };
    case "failed":
      return { status, userOverride };
    case "matched":
      return {
        status: "matched",
        mbRecordingId: "mb-stub",
        score: 1,
        userOverride,
      };
    case "ambiguous":
      return { status: "ambiguous", candidates: [], score: 0.5, userOverride };
  }
}

function track(
  id: string,
  opts: Partial<{
    sourceKind: "file" | "text" | "spotify-import";
    spotifyStatus: "idle" | "pending" | "matched" | "ambiguous" | "missing";
    enrichmentStatus: "idle" | "pending" | "matched" | "ambiguous" | "failed";
    userOverride: boolean;
  }> = {},
): Track {
  return {
    id,
    source: { kind: opts.sourceKind ?? "file", fileName: `${id}.mp3` },
    title: `Title ${id}`,
    artist: `Artist ${id}`,
    spotify: spotifyStateFor(id, opts.spotifyStatus ?? "idle"),
    enrichment: enrichmentStateFor(
      opts.enrichmentStatus ?? "idle",
      opts.userOverride,
    ),
  };
}

function setTracks(tracks: Track[]): void {
  // Reset and populate the store directly without going through
  // addTracks (avoids tickling the undo stack and persistence
  // scheduler in tests).
  const tracksById: Record<string, Track> = {};
  for (const t of tracks) tracksById[t.id] = t;
  usePlaylistStore.setState({
    tracksById,
    playlist: {
      ...usePlaylistStore.getState().playlist,
      trackIds: tracks.map((t) => t.id),
    },
  });
}

beforeEach(() => {
  mocks.searchSpotifyForTrack.mockReset();
  mocks.enrichTrack.mockReset();
  mocks.deleteCachedCandidates.mockReset();
  mocks.probeCoverArtUrl.mockReset();

  searchSpotifyForTrack.mockResolvedValue({
    status: "matched",
    uri: "spotify:track:result",
    candidates: [
      {
        id: "result",
        uri: "spotify:track:result",
        title: "X",
        artist: "Y",
        score: 1,
      },
    ],
  });
  enrichTrack.mockResolvedValue({
    status: "matched",
    candidates: [],
    topScore: 0.9,
    recordingId: "rec-result",
  });

  // A configured clientId is required for matchAllOnSpotify to do
  // any work AND for shouldSkipTrack to gate on Spotify status.
  useSettingsStore.setState((state) => ({
    settings: {
      ...state.settings,
      spotifyClientId: "test-client",
      musicbrainzContact: "test@example.com",
    },
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("matchAllOnSpotify — only processes unresolved tracks", () => {
  it("skips tracks already matched on Spotify", async () => {
    setTracks([
      track("idle-1"),
      track("matched-1", { spotifyStatus: "matched" }),
      track("matched-2", { spotifyStatus: "matched" }),
      track("idle-2"),
    ]);

    await matchAllOnSpotify();

    const calledTrackIds = searchSpotifyForTrack.mock.calls.map(
      (call) => (call[0] as Track).id,
    );
    expect(calledTrackIds.sort()).toEqual(["idle-1", "idle-2"]);
    expect(searchSpotifyForTrack).toHaveBeenCalledTimes(2);
  });

  it("skips spotify-import rows (their URI is the source of truth)", async () => {
    setTracks([
      track("idle-1"),
      track("import-1", {
        sourceKind: "spotify-import",
        spotifyStatus: "matched",
      }),
      // A spotify-import row in `idle` shouldn't happen in practice
      // but matchOne should refuse it anyway — the URI is fixed.
      track("import-2", { sourceKind: "spotify-import" }),
    ]);

    await matchAllOnSpotify();

    const calledTrackIds = searchSpotifyForTrack.mock.calls.map(
      (call) => (call[0] as Track).id,
    );
    expect(calledTrackIds).toEqual(["idle-1"]);
  });

  it("skips ambiguous/missing/pending too — each is a resolved decision", async () => {
    // The user contract: global refresh queues only `idle` (unknown)
    // rows. Ambiguous = waiting on user picker. Missing = Spotify
    // already said no (re-asking burns quota for the same answer).
    // Pending = an earlier call is already in flight. Re-queueing any
    // of these on a re-enrich-all click was the source of the
    // "running re-enrich burns through my Spotify budget" bug.
    setTracks([
      track("idle-1"),
      track("ambiguous-1", { spotifyStatus: "ambiguous" }),
      track("missing-1", { spotifyStatus: "missing" }),
      track("pending-1", { spotifyStatus: "pending" }),
    ]);

    await matchAllOnSpotify();

    const calledTrackIds = searchSpotifyForTrack.mock.calls.map(
      (call) => (call[0] as Track).id,
    );
    expect(calledTrackIds).toEqual(["idle-1"]);
  });

  it("honors a `scope` filter even when other tracks are idle", async () => {
    setTracks([
      track("idle-1"),
      track("idle-2"),
      track("idle-3"),
    ]);

    await matchAllOnSpotify(new Set(["idle-2"]));

    const calledTrackIds = searchSpotifyForTrack.mock.calls.map(
      (call) => (call[0] as Track).id,
    );
    expect(calledTrackIds).toEqual(["idle-2"]);
  });
});

describe("reenrichAll — only queues unresolved tracks (toolbar ↻)", () => {
  it("skips tracks already resolved on Spotify, regardless of MB state", async () => {
    setTracks([
      // Already matched on Spotify AND MB: untouched.
      track("done", {
        spotifyStatus: "matched",
        enrichmentStatus: "matched",
      }),
      // Already missing on Spotify (a resolved decision): skipped.
      track("missing", { spotifyStatus: "missing" }),
      // Ambiguous on Spotify: skipped — needs explicit user action.
      track("ambiguous", { spotifyStatus: "ambiguous" }),
      // Truly idle on Spotify side: included.
      track("idle"),
    ]);

    await reenrichAll();

    const searched = searchSpotifyForTrack.mock.calls.map(
      (call) => (call[0] as Track).id,
    );
    expect(searched).toEqual(["idle"]);
  });

  it("includes a spotify-matched row when its MB side is still idle", async () => {
    setTracks([
      // Resolved both sides: skipped.
      track("done", {
        spotifyStatus: "matched",
        enrichmentStatus: "matched",
      }),
      // Spotify-matched but MB never ran: MB picks it up.
      track("spotify-only", {
        spotifyStatus: "matched",
        enrichmentStatus: "idle",
      }),
    ]);

    await reenrichAll();

    // No Spotify search (no idle-on-Spotify rows in the pending set).
    const searched = searchSpotifyForTrack.mock.calls.map(
      (call) => (call[0] as Track).id,
    );
    expect(searched).toEqual([]);

    // MB enrichment ran for spotify-only.
    const enriched = enrichTrack.mock.calls.map(
      (call) => (call[0] as Track).id,
    );
    expect(enriched).toEqual(["spotify-only"]);
  });

  it("skips userOverride rows even if their status is idle (user has spoken)", async () => {
    setTracks([
      track("override", { userOverride: true }),
      track("normal"),
    ]);

    await reenrichAll();

    const searched = searchSpotifyForTrack.mock.calls.map(
      (call) => (call[0] as Track).id,
    );
    expect(searched).toEqual(["normal"]);
  });

  it("only picks up MB-idle rows for spotify-import (their URI is already set)", async () => {
    setTracks([
      // spotify-import with MB already done: untouched.
      track("import-done", {
        sourceKind: "spotify-import",
        spotifyStatus: "matched",
        enrichmentStatus: "matched",
      }),
      // spotify-import with MB never done: MB queued, Spotify skipped.
      track("import-mb-idle", {
        sourceKind: "spotify-import",
        spotifyStatus: "matched",
        enrichmentStatus: "idle",
      }),
    ]);

    await reenrichAll();

    expect(searchSpotifyForTrack).not.toHaveBeenCalled();
    const enriched = enrichTrack.mock.calls.map(
      (call) => (call[0] as Track).id,
    );
    expect(enriched).toEqual(["import-mb-idle"]);
  });

  it("no-op when the playlist is fully resolved", async () => {
    setTracks([
      track("a", { spotifyStatus: "matched", enrichmentStatus: "matched" }),
      track("b", { spotifyStatus: "matched", enrichmentStatus: "matched" }),
      track("c", { spotifyStatus: "matched", enrichmentStatus: "matched" }),
    ]);

    await reenrichAll();

    expect(searchSpotifyForTrack).not.toHaveBeenCalled();
    expect(enrichTrack).not.toHaveBeenCalled();
  });

  it("the 'unknown' filter is the binding constraint for both APIs (Spotify + MB)", async () => {
    // 100 tracks total; only 5 are unresolved on Spotify and 8 are
    // MB-pending on top of resolved Spotify. A re-enrich-all should
    // queue exactly 5 Spotify searches + (5 newly-matched + 8 still
    // matched-but-MB-idle) = at most 13 MB requests — NOT 100 of
    // either. The earlier failure mode burned the entire quota on
    // already-resolved rows.
    const tracks: Track[] = [];
    for (let i = 0; i < 92; i++) {
      tracks.push(
        track(`done-${i}`, {
          spotifyStatus: "matched",
          enrichmentStatus: "matched",
        }),
      );
    }
    for (let i = 0; i < 5; i++) {
      tracks.push(track(`idle-${i}`));
    }
    for (let i = 0; i < 3; i++) {
      tracks.push(
        track(`mb-only-${i}`, {
          spotifyStatus: "matched",
          enrichmentStatus: "idle",
        }),
      );
    }
    setTracks(tracks);

    await reenrichAll();

    // Spotify searches: exactly the 5 idle rows.
    expect(searchSpotifyForTrack).toHaveBeenCalledTimes(5);
    // MB calls: the 5 idle (now promoted to matched by the mock) +
    // the 3 spotify-matched-but-MB-idle = 8 total. The 92
    // fully-resolved rows must NEVER be touched.
    expect(enrichTrack.mock.calls.length).toBeLessThanOrEqual(8);
    // Crucially, no "done-*" id appears in either call list.
    const allEnrichedIds = enrichTrack.mock.calls.map(
      (call) => (call[0] as Track).id,
    );
    const allSearchedIds = searchSpotifyForTrack.mock.calls.map(
      (call) => (call[0] as Track).id,
    );
    expect(allEnrichedIds.every((id) => !id.startsWith("done-"))).toBe(true);
    expect(allSearchedIds.every((id) => !id.startsWith("done-"))).toBe(true);
  });
});
