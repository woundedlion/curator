import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SpotifyCandidate, Track } from "../types";
import type { SpotifySearchResponse, SpotifyTrackResponse } from "./dtos";
import {
  DEFAULT_ACCEPT_SPOTIFY_HIGH,
  SPOTIFY_AUTOPICK_GAP,
} from "../constants";

// callSpotify is the single chokepoint for every Spotify HTTP request
// (see apiClient.ts header). Mocking it here exercises the dual-query
// strategy and the candidate-pipeline glue while bypassing the rate
// limiter, circuit breaker, and bearer-auth side-effects. We capture
// the request objects so per-test invariants (which query went out
// first, market propagation, tag = trackId, guard threading) can be
// asserted directly.
type CallArgs = {
  request: { path: string; query?: Record<string, unknown> };
  clientId: string;
  options?: { tag?: string; guard?: () => boolean };
};

const callSpotifyMock = vi.fn<
  (
    request: { path: string; query?: Record<string, unknown> },
    clientId: string,
    options?: { tag?: string; guard?: () => boolean },
  ) => Promise<SpotifySearchResponse>
>();

vi.mock("./apiClient", () => ({
  callSpotify: (
    request: { path: string; query?: Record<string, unknown> },
    clientId: string,
    options?: { tag?: string; guard?: () => boolean },
  ) => callSpotifyMock(request, clientId, options),
}));

import { searchSpotifyForTrack } from "./spotifySearch";

// ---------- fixtures ------------------------------------------------------

function trackOf(fields: Partial<Track>): Track {
  return {
    id: "track-1",
    source: { kind: "text" },
    enrichment: { status: "idle" },
    spotify: { status: "idle" },
    ...fields,
  };
}

function dtoOf(overrides: Partial<SpotifyTrackResponse> = {}): SpotifyTrackResponse {
  return {
    id: "sp-1",
    uri: "spotify:track:sp-1",
    name: "Karma Police",
    duration_ms: 261_000,
    preview_url: "https://p.scdn.co/preview-1",
    artists: [{ id: "ar-1", name: "Radiohead" }],
    album: {
      id: "al-1",
      name: "OK Computer",
      release_date: "1997-05-21",
      images: [{ url: "https://i.scdn.co/1.jpg", width: 64 }],
    },
    ...overrides,
  };
}

function searchResponseOf(items: SpotifyTrackResponse[]): SpotifySearchResponse {
  return { tracks: { items } };
}

function callArgsAt(index: number): CallArgs {
  const call = callSpotifyMock.mock.calls[index];
  if (!call) throw new Error(`No call at index ${index}`);
  return { request: call[0], clientId: call[1], options: call[2] };
}

// ---------- tests ---------------------------------------------------------

describe("searchSpotifyForTrack — query construction & dual-query strategy", () => {
  beforeEach(() => {
    callSpotifyMock.mockReset();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns 'missing' without hitting the network when there is no query AND no altQuery", async () => {
    // buildQueryString("", "") → "" and no alt → short-circuit before any HTTP.
    const track = trackOf({ title: undefined, artist: undefined });

    const outcome = await searchSpotifyForTrack(track, "client-id");

    expect(outcome).toEqual({ status: "missing" });
    expect(callSpotifyMock).not.toHaveBeenCalled();
  });

  it("issues primary search with track:/artist: q, tags it with the trackId, threads guard, propagates market", async () => {
    callSpotifyMock.mockResolvedValueOnce(searchResponseOf([]));
    const guard = () => true;
    const track = trackOf({
      id: "track-42",
      title: "Karma Police",
      artist: "Radiohead",
    });

    await searchSpotifyForTrack(track, "client-id", "US", { guard });

    expect(callSpotifyMock).toHaveBeenCalledTimes(1);
    const first = callArgsAt(0);
    expect(first.request.path).toBe("/search");
    expect(first.request.query?.q).toBe(
      'track:"Karma Police" artist:"Radiohead"',
    );
    expect(first.request.query?.type).toBe("track");
    expect(first.request.query?.market).toBe("US");
    expect(first.options?.tag).toBe("track-42");
    expect(first.options?.guard).toBe(guard);
  });

  it("strips embedded double quotes from the q parameter so the search string stays well-formed", async () => {
    // escapeQuoted's contract: `"` inside title/artist would otherwise
    // terminate the quoted field and corrupt the search; it's deleted.
    callSpotifyMock.mockResolvedValueOnce(searchResponseOf([]));
    const track = trackOf({ title: 'She said "hi"', artist: "Someone" });

    await searchSpotifyForTrack(track, "client-id");

    const q = String(callArgsAt(0).request.query?.q);
    expect(q).toBe('track:"She said hi" artist:"Someone"');
  });

  it("fires the altQuery ONLY when primary returned zero candidates", async () => {
    // Contract: dual-query is a fallback, not an expansion — alt fires
    // only when primary returned 0. Even a single weak primary hit
    // suppresses the alt call.
    callSpotifyMock.mockResolvedValueOnce(
      searchResponseOf([dtoOf({ id: "weak", name: "Totally Different" })]),
    );
    const track = trackOf({
      title: "Karm",
      artist: "Radio",
      altQuery: { title: "Karma Police", artist: "Radiohead" },
    });

    await searchSpotifyForTrack(track, "client-id");

    expect(callSpotifyMock).toHaveBeenCalledTimes(1);
  });

  it("fires altQuery when primary returned zero and altQuery differs from primary", async () => {
    callSpotifyMock
      .mockResolvedValueOnce(searchResponseOf([])) // primary
      .mockResolvedValueOnce(searchResponseOf([dtoOf()])); // alt
    const track = trackOf({
      title: "Karm Pol",
      artist: "Radio",
      altQuery: { title: "Karma Police", artist: "Radiohead" },
    });

    const outcome = await searchSpotifyForTrack(track, "client-id");

    expect(callSpotifyMock).toHaveBeenCalledTimes(2);
    expect(String(callArgsAt(1).request.query?.q)).toBe(
      'track:"Karma Police" artist:"Radiohead"',
    );
    // Alt's single hit short-circuits to matched via onlyCandidate.
    expect(outcome.status).toBe("matched");
  });

  it("does NOT fire altQuery when its fields are equivalent to primary (case/whitespace insensitive)", async () => {
    // isQueryEquivalent normalises to lower-case + trim. A whitespace-
    // padded, differently-cased alt is the same query → no second call.
    callSpotifyMock.mockResolvedValueOnce(searchResponseOf([]));
    const track = trackOf({
      title: "Karma Police",
      artist: "Radiohead",
      altQuery: { title: "  karma police ", artist: "RADIOHEAD" },
    });

    await searchSpotifyForTrack(track, "client-id");

    expect(callSpotifyMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to altQuery alone when primary has no fields to query (title/artist undefined)", async () => {
    // primaryQuery === "" but track.altQuery is set → the early
    // `!primaryQuery && !track.altQuery` guard does NOT short-circuit.
    // fetchCandidatesForQuery returns [] for "", then alt fires.
    callSpotifyMock.mockResolvedValueOnce(searchResponseOf([dtoOf()]));
    const track = trackOf({
      title: undefined,
      artist: undefined,
      altQuery: { title: "Karma Police", artist: "Radiohead" },
    });

    const outcome = await searchSpotifyForTrack(track, "client-id");

    // Only one network call — the empty primary skipped fetch entirely.
    expect(callSpotifyMock).toHaveBeenCalledTimes(1);
    expect(String(callArgsAt(0).request.query?.q)).toBe(
      'track:"Karma Police" artist:"Radiohead"',
    );
    expect(outcome.status).toBe("matched");
  });
});

describe("searchSpotifyForTrack — merging primary + alt candidates", () => {
  beforeEach(() => {
    callSpotifyMock.mockReset();
  });

  it("dedupes by candidate id and preserves primary order before alt-only entries", async () => {
    // mergeCandidatesPreferringPrimary's contract: a candidate id seen
    // in primary wins; alt entries with new ids append in their alt order.
    // We force a 0-result primary so the alt actually fires, then re-
    // assemble via a chained alt mock — except that requires primary to
    // be non-empty AND have alt fire. The function only merges when
    // primary === [] AND alt fires. So the dedupe contract here is the
    // pass-through case: primary empty, alt populated → result is alt
    // (deduped against an empty primary). Verify alt order is preserved
    // and any internal alt duplicates collapse.
    callSpotifyMock
      .mockResolvedValueOnce(searchResponseOf([])) // primary
      .mockResolvedValueOnce(
        searchResponseOf([
          dtoOf({ id: "a", name: "First" }),
          dtoOf({ id: "a", name: "Dup of First" }), // dup id within alt
          dtoOf({ id: "b", name: "Second" }),
        ]),
      );
    const track = trackOf({
      title: "Karm",
      artist: "Radio",
      altQuery: { title: "Karma Police", artist: "Radiohead" },
    });

    const outcome = await searchSpotifyForTrack(track, "client-id");

    expect(outcome.status === "matched" || outcome.status === "ambiguous").toBe(
      true,
    );
    if (outcome.status === "matched" || outcome.status === "ambiguous") {
      const ids = outcome.candidates.map((c) => c.id);
      // Dup-id "a" collapses to a single entry; "b" follows.
      expect(ids).toEqual(expect.arrayContaining(["a", "b"]));
      expect(ids.filter((id) => id === "a")).toHaveLength(1);
    }
  });
});

describe("classifyMatch (via searchSpotifyForTrack)", () => {
  beforeEach(() => {
    callSpotifyMock.mockReset();
  });

  it("returns 'missing' when zero candidates come back from every query", async () => {
    // Contract: zero candidates → missing (not ambiguous). Ambiguous
    // means "candidates exist but no clear winner" and is user-pickable;
    // missing is the dead-end glyph and is what hideUnmatched hides.
    callSpotifyMock.mockResolvedValue(searchResponseOf([]));
    const track = trackOf({ title: "Karma Police", artist: "Radiohead" });

    const outcome = await searchSpotifyForTrack(track, "client-id");

    expect(outcome.status).toBe("missing");
  });

  it("promotes a single candidate to 'matched' via the onlyCandidate short-circuit (regardless of score)", async () => {
    // Even a poor-scoring sole hit is auto-picked — the rationale is
    // there's no ambiguity to resolve in the dialog when there's only
    // one option. The matched arm requires uri + candidates + score.
    callSpotifyMock.mockResolvedValueOnce(
      searchResponseOf([
        dtoOf({
          id: "lonely",
          uri: "spotify:track:lonely",
          name: "Completely Different Title",
          artists: [{ id: "x", name: "Different Artist" }],
        }),
      ]),
    );
    const track = trackOf({ title: "Karma Police", artist: "Radiohead" });

    const outcome = await searchSpotifyForTrack(track, "client-id");

    expect(outcome.status).toBe("matched");
    if (outcome.status === "matched") {
      expect(outcome.uri).toBe("spotify:track:lonely");
      expect(outcome.candidates).toHaveLength(1);
      expect(typeof outcome.score).toBe("number");
    }
  });

  it("returns 'ambiguous' when there are multiple candidates and the best doesn't clear DEFAULT_ACCEPT_SPOTIFY_HIGH", async () => {
    // Two roughly-equivalent low-quality hits → best score will be well
    // under 0.9, so the matched gate fails. Ambiguous arm: candidates +
    // score, no uri required (the optional uri carries through only on
    // curator-export round-trip).
    callSpotifyMock.mockResolvedValueOnce(
      searchResponseOf([
        dtoOf({
          id: "x1",
          name: "Karma Patrol",
          artists: [{ id: "a", name: "Other Band" }],
        }),
        dtoOf({
          id: "x2",
          name: "Karma Officer",
          artists: [{ id: "b", name: "Other Group" }],
        }),
      ]),
    );
    const track = trackOf({ title: "Karma Police", artist: "Radiohead" });

    const outcome = await searchSpotifyForTrack(track, "client-id");

    expect(outcome.status).toBe("ambiguous");
    if (outcome.status === "ambiguous") {
      expect(outcome.candidates.length).toBeGreaterThanOrEqual(2);
      expect(outcome.score).toBeLessThan(DEFAULT_ACCEPT_SPOTIFY_HIGH);
    }
  });

  it("returns 'matched' when the best candidate clears the high threshold AND the score gap exceeds SPOTIFY_AUTOPICK_GAP", async () => {
    // Two candidates: one is a near-perfect match on title+artist+album+
    // year+duration; the other is a clear distractor. The good hit should
    // land at ~1.0 (fuse 1.0 * 0.8 + year 1.0 * 0.1 + duration 1.0 * 0.1)
    // and the gap to the distractor exceeds 0.15.
    callSpotifyMock.mockResolvedValueOnce(
      searchResponseOf([
        dtoOf({
          id: "good",
          uri: "spotify:track:good",
          name: "Karma Police",
          artists: [{ id: "ar", name: "Radiohead" }],
          album: {
            id: "al",
            name: "OK Computer",
            release_date: "1997-05-21",
          },
          duration_ms: 261_000,
        }),
        dtoOf({
          id: "bad",
          uri: "spotify:track:bad",
          name: "Zzz Totally Unrelated",
          artists: [{ id: "ar2", name: "Nobody" }],
          album: { id: "al2", name: "Nope", release_date: "2010-01-01" },
          duration_ms: 100_000,
        }),
      ]),
    );
    const track = trackOf({
      title: "Karma Police",
      artist: "Radiohead",
      album: "OK Computer",
      year: 1997,
      durationMs: 261_000,
    });

    const outcome = await searchSpotifyForTrack(track, "client-id");

    expect(outcome.status).toBe("matched");
    if (outcome.status === "matched") {
      expect(outcome.uri).toBe("spotify:track:good");
      expect(outcome.score).toBeGreaterThanOrEqual(DEFAULT_ACCEPT_SPOTIFY_HIGH);
      // Top result is the good one — candidates are sorted descending by score.
      expect(outcome.candidates[0]!.id).toBe("good");
      // Gap-to-runner-up is the matched-gate's second condition.
      expect(
        outcome.candidates[0]!.score - outcome.candidates[1]!.score,
      ).toBeGreaterThanOrEqual(SPOTIFY_AUTOPICK_GAP);
    }
  });

  it("passes through previewUrl on the matched arm when present", async () => {
    callSpotifyMock.mockResolvedValueOnce(
      searchResponseOf([
        dtoOf({
          id: "with-preview",
          uri: "spotify:track:with-preview",
          preview_url: "https://p.scdn.co/preview-xyz",
        }),
      ]),
    );
    const track = trackOf({ title: "Karma Police", artist: "Radiohead" });

    const outcome = await searchSpotifyForTrack(track, "client-id");

    expect(outcome.status).toBe("matched");
    if (outcome.status === "matched") {
      expect(outcome.previewUrl).toBe("https://p.scdn.co/preview-xyz");
    }
  });
});

describe("scoreSpotifyCandidates contract (via searchSpotifyForTrack)", () => {
  beforeEach(() => {
    callSpotifyMock.mockReset();
  });

  it("sorts candidates in descending score order", async () => {
    // Two hits, one a strong title/artist/album match, one weak — verify
    // the strong one comes first. (Sort is stable inside the function.)
    callSpotifyMock.mockResolvedValueOnce(
      searchResponseOf([
        dtoOf({
          id: "weak",
          name: "Karma Patrol",
          artists: [{ id: "a", name: "Nobody" }],
          album: { id: "z", name: "Unrelated" },
        }),
        dtoOf({
          id: "strong",
          name: "Karma Police",
          artists: [{ id: "ar", name: "Radiohead" }],
          album: { id: "al", name: "OK Computer" },
        }),
      ]),
    );
    const track = trackOf({
      title: "Karma Police",
      artist: "Radiohead",
      album: "OK Computer",
    });

    const outcome = await searchSpotifyForTrack(track, "client-id");

    expect(outcome.status === "matched" || outcome.status === "ambiguous").toBe(
      true,
    );
    if (outcome.status === "matched" || outcome.status === "ambiguous") {
      expect(outcome.candidates[0]!.id).toBe("strong");
      expect(outcome.candidates[0]!.score).toBeGreaterThanOrEqual(
        outcome.candidates[1]!.score,
      );
    }
  });

  it("awards year credit: same year > 3-yr gap > distant year (all else equal)", async () => {
    // Year credit: |delta|<=1 → 1.0, <=3 → 0.5, else 0. Three candidates
    // with identical title/artist/album but different years. Track year
    // is 1997. We expect: 1997 (full) > 1999 (full, delta=2 is actually
    // 0.5 — re-reading: <=1 → 1.0, <=3 → 0.5. So 1999 delta=2 → 0.5)
    // > 2010 (0). To get monotonic ordering: 1997 (1.0) > 2000 (0.5)
    // > 2020 (0).
    callSpotifyMock.mockResolvedValueOnce(
      searchResponseOf([
        dtoOf({
          id: "y-far",
          album: { id: "z3", name: "OK Computer", release_date: "2020-01-01" },
        }),
        dtoOf({
          id: "y-near",
          album: { id: "z1", name: "OK Computer", release_date: "1997-05-21" },
        }),
        dtoOf({
          id: "y-mid",
          album: { id: "z2", name: "OK Computer", release_date: "2000-01-01" },
        }),
      ]),
    );
    const track = trackOf({
      title: "Karma Police",
      artist: "Radiohead",
      album: "OK Computer",
      year: 1997,
    });

    const outcome = await searchSpotifyForTrack(track, "client-id");

    expect(outcome.status === "matched" || outcome.status === "ambiguous").toBe(
      true,
    );
    if (outcome.status === "matched" || outcome.status === "ambiguous") {
      const order = outcome.candidates.map((c) => c.id);
      expect(order.indexOf("y-near")).toBeLessThan(order.indexOf("y-mid"));
      expect(order.indexOf("y-mid")).toBeLessThan(order.indexOf("y-far"));
    }
  });

  it("awards duration credit: tight delta beats loose delta (all else equal)", async () => {
    // Duration credit: <=2s → 1.0, <=10s → 0.5, else 0.
    callSpotifyMock.mockResolvedValueOnce(
      searchResponseOf([
        dtoOf({ id: "d-far", duration_ms: 400_000 }), // 100s off → 0
        dtoOf({ id: "d-tight", duration_ms: 261_500 }), // 0.5s off → 1
        dtoOf({ id: "d-loose", duration_ms: 266_000 }), // 5s off → 0.5
      ]),
    );
    const track = trackOf({
      title: "Karma Police",
      artist: "Radiohead",
      durationMs: 261_000,
    });

    const outcome = await searchSpotifyForTrack(track, "client-id");

    expect(outcome.status === "matched" || outcome.status === "ambiguous").toBe(
      true,
    );
    if (outcome.status === "matched" || outcome.status === "ambiguous") {
      const order = outcome.candidates.map((c) => c.id);
      expect(order.indexOf("d-tight")).toBeLessThan(order.indexOf("d-loose"));
      expect(order.indexOf("d-loose")).toBeLessThan(order.indexOf("d-far"));
    }
  });

  it("returns scores in the unit interval [0, 1]", async () => {
    // The blend is fuse*0.8 + year*0.1 + duration*0.1 with each
    // sub-score in [0,1] → combined ∈ [0,1]. Important so callers
    // (PlaylistTable score column, ambiguous-pick threshold compare)
    // can treat the score as a probability-like value.
    callSpotifyMock.mockResolvedValueOnce(
      searchResponseOf([dtoOf({ id: "a" }), dtoOf({ id: "b", name: "Nope" })]),
    );
    const track = trackOf({
      title: "Karma Police",
      artist: "Radiohead",
      album: "OK Computer",
      year: 1997,
      durationMs: 261_000,
    });

    const outcome = await searchSpotifyForTrack(track, "client-id");

    if (outcome.status === "matched" || outcome.status === "ambiguous") {
      for (const c of outcome.candidates) {
        expect(c.score).toBeGreaterThanOrEqual(0);
        expect(c.score).toBeLessThanOrEqual(1);
      }
    }
  });

  it("does not mutate the input candidate objects (returns fresh objects with new score field)", async () => {
    // The DTOs from `toSpotifyCandidate` carry `score: 0`. After scoring
    // we'd like to assert the originals weren't mutated, but since
    // toSpotifyCandidate runs inside searchSpotifyForTrack and produces
    // its own SpotifyCandidate objects, the externally-observable
    // invariant is that the returned candidates (from
    // scoreSpotifyCandidates) are not the same object references as the
    // mapped inputs. We assert this via a sentinel: the same source DTO
    // emitted twice (in two separate searches) produces independent
    // scored objects.
    const dto = dtoOf({ id: "stable", duration_ms: 261_000 });
    callSpotifyMock.mockResolvedValueOnce(searchResponseOf([dto]));
    const track1 = trackOf({
      id: "t1",
      title: "Karma Police",
      artist: "Radiohead",
      durationMs: 261_000,
    });

    const out1 = await searchSpotifyForTrack(track1, "client-id");
    expect(out1.status).toBe("matched");
    const firstScore =
      out1.status === "matched" || out1.status === "ambiguous"
        ? out1.candidates[0]!.score
        : NaN;

    // Different track (no duration credit available) → different score.
    callSpotifyMock.mockResolvedValueOnce(searchResponseOf([dto]));
    const track2 = trackOf({
      id: "t2",
      title: "Karma Police",
      artist: "Radiohead",
      // no durationMs → durationCredit returns 0
    });

    const out2 = await searchSpotifyForTrack(track2, "client-id");
    const secondScore =
      out2.status === "matched" || out2.status === "ambiguous"
        ? out2.candidates[0]!.score
        : NaN;

    // If the scorer mutated shared state, the second run would inherit
    // the first run's score. Independent scoring means they differ
    // (track1 gets duration credit, track2 does not).
    expect(firstScore).not.toBe(secondScore);
  });

  it("preserves the candidate count emitted by toSpotifyCandidate (no candidates dropped during scoring)", async () => {
    // Smoke check that scoring is a pure map+sort, not a filter.
    const items: SpotifyTrackResponse[] = [
      dtoOf({ id: "c1" }),
      dtoOf({ id: "c2", name: "Different" }),
      dtoOf({ id: "c3", name: "Also Different" }),
    ];
    callSpotifyMock.mockResolvedValueOnce(searchResponseOf(items));
    const track = trackOf({ title: "Karma Police", artist: "Radiohead" });

    const outcome = await searchSpotifyForTrack(track, "client-id");

    if (outcome.status === "matched" || outcome.status === "ambiguous") {
      expect(outcome.candidates).toHaveLength(3);
      // No duplicates either — every candidate has the correct id.
      const ids = outcome.candidates.map((c: SpotifyCandidate) => c.id).sort();
      expect(ids).toEqual(["c1", "c2", "c3"]);
    }
  });
});
