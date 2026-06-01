import { describe, expect, it } from "vitest";
import {
  SCORER_FIELD_WEIGHTS,
  SCORER_YEAR_WEIGHT,
  scoreCandidates,
} from "./candidateScorer";
import type { MBCandidate, Track } from "../types";

function buildCandidate(overrides: Partial<MBCandidate>): MBCandidate {
  return {
    recordingId: overrides.recordingId ?? "rec",
    title: overrides.title ?? "",
    artist: overrides.artist ?? "",
    album: overrides.album,
    year: overrides.year,
    score: 0,
  };
}

function buildTrack(overrides: Partial<Track>): Track {
  return {
    id: "t",
    source: { kind: "text", rawLine: "" },
    enrichment: { status: "idle" },
    spotify: { status: "idle" },
    ...overrides,
  };
}

describe("scoreCandidates", () => {
  it("returns empty for empty input", () => {
    expect(scoreCandidates(buildTrack({}), [])).toEqual([]);
  });

  it("INVARIANT: field weights sum to (1 - YEAR_WEIGHT) so the realized split matches DESIGN §4.3", () => {
    // Fuse normalizes the key weights to sum to 1, and the scorer rescales
    // the Fuse component by (1 - YEAR_WEIGHT). The documented aggregate
    // split (title 0.50 / artist 0.30 / album 0.15 / year 0.05) only holds
    // when the field weights sum to exactly (1 - YEAR_WEIGHT). Guard it so a
    // future weight retune can't silently drift the contract.
    const fieldSum =
      SCORER_FIELD_WEIGHTS.title +
      SCORER_FIELD_WEIGHTS.artist +
      SCORER_FIELD_WEIGHTS.album;
    expect(fieldSum).toBeCloseTo(1 - SCORER_YEAR_WEIGHT, 10);
  });

  it("ranks the best title/artist match first", () => {
    const candidates = [
      buildCandidate({
        recordingId: "wrong",
        title: "Completely Different Song",
        artist: "Other Artist",
      }),
      buildCandidate({
        recordingId: "right",
        title: "Karma Police",
        artist: "Radiohead",
        album: "OK Computer",
        year: 1997,
      }),
    ];
    const track = buildTrack({
      title: "Karma Police",
      artist: "Radiohead",
      album: "OK Computer",
      year: 1997,
    });
    const out = scoreCandidates(track, candidates);
    expect(out[0]!.recordingId).toBe("right");
    expect(out[0]!.score).toBeGreaterThan(out[1]!.score);
  });

  it("prefers the year-aligned candidate as a tie-breaker when other fields match", () => {
    const candidates = [
      buildCandidate({
        recordingId: "remaster",
        title: "Karma Police",
        artist: "Radiohead",
        album: "OK Computer",
        year: 2017,
      }),
      buildCandidate({
        recordingId: "original",
        title: "Karma Police",
        artist: "Radiohead",
        album: "OK Computer",
        year: 1997,
      }),
    ];
    const track = buildTrack({
      title: "Karma Police",
      artist: "Radiohead",
      album: "OK Computer",
      year: 1997,
    });
    const out = scoreCandidates(track, candidates);
    expect(out[0]!.recordingId).toBe("original");
  });

  it("attaches a score to every returned candidate", () => {
    const candidates = [
      buildCandidate({
        recordingId: "a",
        title: "Karma Police",
        artist: "Radiohead",
      }),
      buildCandidate({
        recordingId: "b",
        title: "Idioteque",
        artist: "Radiohead",
      }),
    ];
    const out = scoreCandidates(
      buildTrack({ title: "Karma Police", artist: "Radiohead" }),
      candidates,
    );
    for (const candidate of out) {
      expect(typeof candidate.score).toBe("number");
      expect(Number.isFinite(candidate.score)).toBe(true);
    }
  });

  // REGRESSION: a track with no album (every plain-text import) must still
  // rank by title/artist. The Fuse object query is a logical AND across keys,
  // and an empty-string `album` sub-query matches nothing — so including
  // `album: ""` returned [] from search, collapsing every fuseScore to 0 and
  // leaving the candidates ordered by year only. The scorer now omits empty
  // query fields. Asserting RANKING (not just finiteness) is what catches the
  // regression: under the bug both scores were equal (year-only), so the
  // wrong-title candidate could sort first.
  it("ranks by title/artist when the track has no album (text-import path)", () => {
    const candidates = [
      buildCandidate({
        recordingId: "wrong",
        title: "Idioteque",
        artist: "Radiohead",
      }),
      buildCandidate({
        recordingId: "right",
        title: "Karma Police",
        artist: "Radiohead",
      }),
    ];
    const track = buildTrack({ title: "Karma Police", artist: "Radiohead" });
    const out = scoreCandidates(track, candidates);
    expect(out[0]!.recordingId).toBe("right");
    expect(out[0]!.score).toBeGreaterThan(out[1]!.score);
  });

  // REGRESSION: a title-only `.txt` line (no artist, no album) must still
  // produce a usable title ranking rather than all-zero scores.
  it("ranks by title when the track has only a title", () => {
    const candidates = [
      buildCandidate({ recordingId: "wrong", title: "Paranoid Android" }),
      buildCandidate({ recordingId: "right", title: "Karma Police" }),
    ];
    const out = scoreCandidates(buildTrack({ title: "Karma Police" }), candidates);
    expect(out[0]!.recordingId).toBe("right");
    expect(out[0]!.score).toBeGreaterThan(out[1]!.score);
  });

  it("does not mutate the input array", () => {
    const original = [
      buildCandidate({ recordingId: "a", title: "Karma Police" }),
      buildCandidate({ recordingId: "b", title: "Idioteque" }),
    ];
    const before = original.map((c) => c.recordingId);
    scoreCandidates(buildTrack({ title: "Idioteque" }), original);
    expect(original.map((c) => c.recordingId)).toEqual(before);
  });
});
