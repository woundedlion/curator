import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MBCandidate, Track } from "../types";

type CachedCandidatesResult =
  | { kind: "miss" }
  | { kind: "cached"; candidates: MBCandidate[] };

type SearchOptions = { tag?: string; guard?: () => boolean };
const searchRecordingsMock =
  vi.fn<
    (query: string, contact: string, options?: SearchOptions) => Promise<MBCandidate[]>
  >();
const readCacheMock = vi.fn<(key: unknown) => Promise<CachedCandidatesResult>>();
const writeCacheMock = vi.fn<(key: unknown, candidates: MBCandidate[]) => Promise<void>>();

vi.mock("./musicbrainzClient", () => ({
  // Forward the 3rd `options` arg ({tag, guard}) so tests can assert the
  // cancellation plumbing is threaded through fetchAndScore → searchRecordings.
  searchRecordings: (query: string, contact: string, options?: SearchOptions) =>
    searchRecordingsMock(query, contact, options),
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
    readCacheMock.mockResolvedValue({ kind: "miss" });
    writeCacheMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("threads the track id as tag and forwards the guard to searchRecordings", async () => {
    searchRecordingsMock.mockResolvedValue([candidate()]);
    const guard = (): boolean => true;
    const track = trackOf({
      title: "Karma Police",
      artist: "Radiohead",
      album: "OK Computer",
      year: 1997,
    });
    await enrichTrack(track, "me@example.com", 0.75, { guard });
    expect(searchRecordingsMock).toHaveBeenCalledWith(
      expect.any(String),
      "me@example.com",
      { tag: "track-1", guard },
    );
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

  it("short-circuits on a cache hit when the cache auto-matches and altQuery isn't needed", async () => {
    readCacheMock.mockResolvedValue({ kind: "cached", candidates: [candidate()] });
    const track = trackOf({ title: "Karma Police", artist: "Radiohead" });

    const outcome = await enrichTrack(track, "me@example.test", 0.75);

    expect(searchRecordingsMock).not.toHaveBeenCalled();
    expect(outcome.candidates).toHaveLength(1);
  });

  it("does NOT rewrite the cache on a cache hit (no churn on cachedAt)", async () => {
    readCacheMock.mockResolvedValue({ kind: "cached", candidates: [candidate()] });
    const track = trackOf({ title: "Karma Police", artist: "Radiohead" });

    await enrichTrack(track, "me@example.test", 0.75);

    expect(writeCacheMock).not.toHaveBeenCalled();
  });

  it("still fires altQuery on a CACHE HIT when the cached primary doesn't auto-match (regression)", async () => {
    // Before the fix, any non-empty cache read short-circuited the
    // function with `return classifyOutcome(...)`, skipping the
    // altQuery branch entirely. A track first enriched without an
    // altQuery (or before altQuery was derived) would then get a
    // permanently degraded match — every subsequent re-enrich would
    // early-return on the cache hit and the altQuery would never fire.
    readCacheMock.mockResolvedValue({
      kind: "cached",
      candidates: [
        // Cached primary candidate scores poorly against the track —
        // wrong title and artist mean classifyOutcome → ambiguous.
        candidate({ title: "Some Other Song", artist: "Some Other Artist" }),
      ],
    });
    searchRecordingsMock.mockResolvedValueOnce([
      candidate({
        recordingId: "alt-hit",
        title: "Karma Police",
        artist: "Radiohead",
      }),
    ]);
    const track = trackOf({
      title: "Karm Pol",
      artist: "Radio",
      altQuery: { title: "Karma Police", artist: "Radiohead" },
    });

    const outcome = await enrichTrack(track, "me@example.test", 0.6);

    // Alt query fired (primary fetch did NOT — cache fed primary).
    expect(searchRecordingsMock).toHaveBeenCalledTimes(1);
    // And the alt's strong candidate now shows up in the merged set,
    // so the outcome isn't stuck at the degraded cache-only ambiguous.
    const recIds = outcome.candidates.map((c) => c.recordingId);
    expect(recIds).toContain("alt-hit");
  });

  it("bypassCache option skips the cache read but still writes results", async () => {
    readCacheMock.mockResolvedValue({
      kind: "cached",
      candidates: [candidate({ recordingId: "stale", title: "Stale Cached" })],
    });
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

  it("REGRESSION: gates each merged candidate against the reference it was scored against (no cross-reference accept)", async () => {
    // Bug: after merging primary+alt, classifyOutcome ran the
    // similarity gate against `altScoringTrack` for whichever candidate
    // sorted FIRST — even a PRIMARY candidate (scored against the
    // unmodified track). That made ranking and the gate incoherent: a
    // primary candidate that does NOT resemble the track (so its primary
    // similarity gate fails in pass 1 → ambiguous) could be wrongly
    // ACCEPTED in the merged pass simply because its title happened to
    // resemble the unrelated altQuery. The fix gates each candidate
    // against the reference its score came from, so a primary candidate
    // is always judged against the track fields — keeping it ambiguous.
    //
    // Setup: the primary candidate's title matches the ALT query, not
    // the track. Pass 1 (primary vs track) → ambiguous (similarity vs
    // track fails). The alt fires; its single candidate scores lower, so
    // the primary candidate sorts first in the merged set. Under the OLD
    // code that primary candidate would be gated vs the alt reference
    // (which it matches) → spurious "matched". Under the fix it's gated
    // vs the track (which it does not match) → stays "ambiguous".
    searchRecordingsMock
      .mockResolvedValueOnce([
        // Primary candidate: artist matches the track (drives a decent
        // Fuse score so it sorts first), but its TITLE does not resemble
        // the track title — so the primary similarity gate fails. Its
        // title/artist DO match the altQuery, which is the trap.
        candidate({
          recordingId: "primary-looks-like-alt",
          title: "Xylophone Interlude",
          artist: "Radiohead",
          album: undefined,
          year: undefined,
        }),
      ])
      .mockResolvedValueOnce([
        // Alt candidate: a terrible match for the altScoringTrack so it
        // scores below the primary candidate and does NOT sort first.
        candidate({
          recordingId: "alt-weak",
          title: "Qqqqqqq Unrelated",
          artist: "Wwwwwww Nobody",
        }),
      ]);
    const track = trackOf({
      title: "Karma Police",
      artist: "Radiohead",
      // altQuery matches the primary candidate's fields exactly — the
      // OLD code would gate the primary candidate against THIS and
      // wrongly accept it.
      altQuery: { title: "Xylophone Interlude", artist: "Radiohead" },
    });

    // Low threshold so scoreOk is satisfied for the top candidate — this
    // isolates the SIMILARITY gate / reference choice as the deciding
    // factor (the whole point of the regression).
    const outcome = await enrichTrack(track, "me@example.test", 0.01);

    // Both passes fired (primary then alt).
    expect(searchRecordingsMock).toHaveBeenCalledTimes(2);
    // The primary candidate sorts first but does NOT resemble the TRACK
    // title, so with coherent per-candidate gating (vs the primary
    // reference) it must NOT auto-match — even though it matches the
    // altQuery. The OLD code accepted it; the fix keeps it ambiguous.
    expect(outcome.candidates[0]!.recordingId).toBe("primary-looks-like-alt");
    expect(outcome.status).toBe("ambiguous");
    expect(outcome.recordingId).toBeUndefined();
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
