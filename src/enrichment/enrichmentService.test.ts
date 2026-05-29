import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MBCandidate, Track } from "../types";

const searchRecordingsMock = vi.fn<(query: string, contact: string) => Promise<MBCandidate[]>>();
const readCacheMock = vi.fn<(key: unknown) => Promise<MBCandidate[] | null>>();
const writeCacheMock = vi.fn<(key: unknown, candidates: MBCandidate[]) => Promise<void>>();

vi.mock("./musicbrainzClient", () => ({
  searchRecordings: (query: string, contact: string) =>
    searchRecordingsMock(query, contact),
}));

vi.mock("../db/musicbrainzCache", () => ({
  readCachedCandidates: (key: unknown) => readCacheMock(key),
  writeCachedCandidates: (key: unknown, candidates: MBCandidate[]) =>
    writeCacheMock(key, candidates),
  // Production code normalizes inside the cache module; here we pass
  // the raw track fields through so existing key-shape assertions
  // continue to compare against title/artist/album literals.
  cacheKeyForTrack: (track: {
    title?: string;
    artist?: string;
    album?: string;
  }) => ({ title: track.title, artist: track.artist, album: track.album }),
}));

import { enrichTrack } from "./enrichmentService";

function trackOf(fields: Partial<Track>): Track {
  return {
    id: "track-1",
    source: { kind: "text" },
    enrichment: { status: "idle" },
    spotify: { status: "idle" },
    ...fields,
  };
}

function candidate(overrides: Partial<MBCandidate> = {}): MBCandidate {
  return {
    recordingId: "rec-1",
    title: "Karma Police",
    artist: "Radiohead",
    album: "OK Computer",
    year: 1997,
    score: 0,
    ...overrides,
  };
}

describe("enrichTrack", () => {
  beforeEach(() => {
    searchRecordingsMock.mockReset();
    readCacheMock.mockReset();
    writeCacheMock.mockReset();
    readCacheMock.mockResolvedValue(null);
    writeCacheMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns 'matched' when score and similarity guards pass", async () => {
    searchRecordingsMock.mockResolvedValue([candidate()]);
    const track = trackOf({
      title: "Karma Police",
      artist: "Radiohead",
      album: "OK Computer",
      year: 1997,
    });

    const outcome = await enrichTrack(track, "me@example.test", 0.75);

    expect(outcome.status).toBe("matched");
    expect(outcome.recordingId).toBe("rec-1");
    expect(outcome.candidates).toHaveLength(1);
    expect(outcome.topScore).toBeGreaterThanOrEqual(0.75);
  });

  it("returns 'ambiguous' when title similarity guard fails despite a high Fuse hit", async () => {
    searchRecordingsMock.mockResolvedValue([
      candidate({
        title: "Completely Unrelated Title",
        artist: "Radiohead",
      }),
    ]);
    const track = trackOf({
      title: "Karma Police",
      artist: "Radiohead",
    });

    const outcome = await enrichTrack(track, "me@example.test", 0.5);

    expect(outcome.status).toBe("ambiguous");
    expect(outcome.recordingId).toBeUndefined();
  });

  it("returns 'failed' with no-results when MB returns nothing", async () => {
    searchRecordingsMock.mockResolvedValue([]);
    const track = trackOf({ title: "Nonexistent Song", artist: "Nobody" });

    const outcome = await enrichTrack(track, "me@example.test", 0.75);

    expect(outcome.status).toBe("failed");
    expect(outcome.failureReason).toBe("no-results");
  });

  it("returns 'failed' with no-query when title and artist are both missing", async () => {
    searchRecordingsMock.mockResolvedValue([]);
    const track = trackOf({}); // no title, no artist

    const outcome = await enrichTrack(track, "me@example.test", 0.75);

    expect(outcome.status).toBe("failed");
    expect(outcome.failureReason).toBe("no-query");
    // buildRecordingQuery returns "" with no fields → searchRecordings short-circuits.
    expect(searchRecordingsMock).not.toHaveBeenCalled();
  });

  it("short-circuits on a cache hit and does not hit the network", async () => {
    readCacheMock.mockResolvedValue([candidate()]);
    const track = trackOf({ title: "Karma Police", artist: "Radiohead" });

    const outcome = await enrichTrack(track, "me@example.test", 0.75);

    expect(searchRecordingsMock).not.toHaveBeenCalled();
    expect(outcome.candidates).toHaveLength(1);
  });

  it("bypassCache option skips the cache read but still writes results", async () => {
    readCacheMock.mockResolvedValue([
      candidate({ recordingId: "stale", title: "Stale Cached" }),
    ]);
    searchRecordingsMock.mockResolvedValue([candidate({ recordingId: "fresh" })]);
    const track = trackOf({ title: "Karma Police", artist: "Radiohead" });

    const outcome = await enrichTrack(track, "me@example.test", 0.75, {
      bypassCache: true,
    });

    expect(readCacheMock).not.toHaveBeenCalled();
    expect(searchRecordingsMock).toHaveBeenCalled();
    expect(outcome.candidates[0]!.recordingId).toBe("fresh");
    expect(writeCacheMock).toHaveBeenCalled();
  });

  it("does NOT write the cache when results are empty", async () => {
    searchRecordingsMock.mockResolvedValue([]);
    const track = trackOf({ title: "Karma Police", artist: "Radiohead" });

    await enrichTrack(track, "me@example.test", 0.75);

    expect(writeCacheMock).not.toHaveBeenCalled();
  });

  it("fires the altQuery when primary doesn't match and altQuery differs", async () => {
    // Primary returns nothing → status is failed (no-results). shouldTryAlt
    // requires outcome.status !== "matched", which "failed" satisfies, so alt
    // is supposed to fire even when primary returned an empty list.
    searchRecordingsMock
      .mockResolvedValueOnce([]) // primary
      .mockResolvedValueOnce([
        candidate({
          title: "Karma Police",
          artist: "Radiohead",
          album: "OK Computer",
          year: 1997,
        }),
      ]); // alt
    const track = trackOf({
      title: "Karm Pol",
      artist: "Radio",
      album: "OK Computer",
      year: 1997,
      altQuery: { title: "Karma Police", artist: "Radiohead" },
    });

    const outcome = await enrichTrack(track, "me@example.test", 0.6);

    expect(searchRecordingsMock).toHaveBeenCalledTimes(2);
    expect(outcome.status).toBe("matched");
  });

  it("does NOT fire the altQuery when the primary already matched", async () => {
    searchRecordingsMock.mockResolvedValue([candidate()]);
    const track = trackOf({
      title: "Karma Police",
      artist: "Radiohead",
      album: "OK Computer",
      year: 1997,
      altQuery: { title: "Different Title", artist: "Different Artist" },
    });

    await enrichTrack(track, "me@example.test", 0.6);

    expect(searchRecordingsMock).toHaveBeenCalledTimes(1);
  });

  it("does NOT fire the altQuery when the altQuery has identical title and artist", async () => {
    searchRecordingsMock.mockResolvedValue([]);
    const track = trackOf({
      title: "Karma Police",
      artist: "Radiohead",
      altQuery: { title: "Karma Police", artist: "Radiohead" },
    });

    await enrichTrack(track, "me@example.test", 0.75);

    expect(searchRecordingsMock).toHaveBeenCalledTimes(1);
  });

  it("does NOT return 'no-query' when primary fields are missing but alt-query produced a match (regression)", async () => {
    // The previous early-return for "title and artist both undefined"
    // clobbered a successful alt outcome with `failureReason: no-query`.
    // The fix: only return no-query when alt also had nothing to query.
    // Primary builds an empty query (title/artist undefined) so
    // searchRecordings is NOT called for it — the alt is the only
    // request that fires.
    searchRecordingsMock.mockResolvedValueOnce([
      candidate({
        title: "Karma Police",
        artist: "Radiohead",
        album: "OK Computer",
        year: 1997,
      }),
    ]);
    const track = trackOf({
      title: undefined,
      artist: undefined,
      altQuery: { title: "Karma Police", artist: "Radiohead" },
    });

    const outcome = await enrichTrack(track, "me@example.test", 0.6);

    expect(searchRecordingsMock).toHaveBeenCalledTimes(1);
    // The key regression assertion: outcome must NOT be the spurious
    // failed/no-query that the prior early return produced. Whether the
    // alt's single candidate scores high enough for "matched" vs
    // "ambiguous" depends on the scorer, but both are valid outcomes —
    // what matters is the alt's work isn't clobbered.
    expect(outcome.status).not.toBe("failed");
    expect(outcome.failureReason).toBeUndefined();
    expect(outcome.candidates).toHaveLength(1);
  });

  it("returns 'no-query' only when both primary AND alt have nothing to query", async () => {
    // Primary fields undefined, alt also undefined — true no-query.
    const track = trackOf({ title: undefined, artist: undefined });

    const outcome = await enrichTrack(track, "me@example.test", 0.6);

    expect(searchRecordingsMock).not.toHaveBeenCalled();
    expect(outcome.status).toBe("failed");
    expect(outcome.failureReason).toBe("no-query");
  });

  it("merges primary + alt candidates and dedupes by recordingId, preferring primary order", async () => {
    searchRecordingsMock
      .mockResolvedValueOnce([
        candidate({ recordingId: "primary-1", title: "Foo Primary" }),
        candidate({ recordingId: "shared", title: "Foo Primary" }),
      ])
      .mockResolvedValueOnce([
        candidate({ recordingId: "shared", title: "Foo Primary" }), // duplicate
        candidate({ recordingId: "alt-1", title: "Foo Alt" }),
      ]);
    const track = trackOf({
      // Title/artist that won't pass any similarity guard, ensuring outcome
      // stays "ambiguous" so the alt fires AND the merged set is preserved.
      title: "Karm",
      artist: "Radio",
      altQuery: { title: "Karma Police", artist: "Radiohead" },
    });

    const outcome = await enrichTrack(track, "me@example.test", 0.99); // unreachable

    expect(outcome.status).toBe("ambiguous");
    const ids = outcome.candidates.map((c) => c.recordingId).sort();
    expect(ids).toEqual(["alt-1", "primary-1", "shared"]);
  });

});
