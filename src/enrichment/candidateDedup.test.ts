import { describe, expect, it } from "vitest";
import { dedupeBySongIdentity } from "./candidateDedup";
import type { MBCandidate, Track } from "../types";

function buildCandidate(overrides: Partial<MBCandidate>): MBCandidate {
  return {
    recordingId: overrides.recordingId ?? "rec",
    title: overrides.title ?? "Karma Police",
    artist: overrides.artist ?? "Radiohead",
    album: overrides.album,
    year: overrides.year,
    score: overrides.score ?? 0,
  };
}

function buildTrack(year?: number): Track {
  return {
    id: "track-1",
    source: { kind: "text", rawLine: "Radiohead - Karma Police" },
    year,
    enrichment: { status: "idle" },
    spotify: { status: "idle" },
  };
}

describe("dedupeBySongIdentity", () => {
  it("keeps a single candidate per (normalized title|artist) group", () => {
    const candidates = [
      buildCandidate({ recordingId: "a", year: 1997 }),
      buildCandidate({ recordingId: "b", year: 2007, title: "Karma Police (Remastered 2007)" }),
      buildCandidate({ recordingId: "c", year: 2017, title: "Karma Police (Live)" }),
    ];
    const out = dedupeBySongIdentity(candidates, buildTrack());
    expect(out).toHaveLength(1);
  });

  it("does NOT collapse candidates with different normalized titles", () => {
    const candidates = [
      buildCandidate({ recordingId: "a", title: "Karma Police" }),
      buildCandidate({ recordingId: "b", title: "Idioteque" }),
    ];
    const out = dedupeBySongIdentity(candidates, buildTrack());
    expect(out).toHaveLength(2);
  });

  it("picks the closest year to the track's tagged year", () => {
    const candidates = [
      buildCandidate({ recordingId: "old", year: 1995 }),
      buildCandidate({ recordingId: "rec-1997", year: 1997 }),
      buildCandidate({ recordingId: "remaster", year: 2017 }),
    ];
    // Track year 1998: deltas are old=3, rec-1997=1, remaster=19. 1997 wins.
    const out = dedupeBySongIdentity(candidates, buildTrack(1998));
    expect(out).toHaveLength(1);
    expect(out[0].recordingId).toBe("rec-1997");
  });

  it("breaks year-delta ties in favor of the first candidate seen", () => {
    const candidates = [
      buildCandidate({ recordingId: "old", year: 1995 }),
      buildCandidate({ recordingId: "newer", year: 1997 }),
    ];
    // Track year 1996 makes both deltas = 1. Strict-less-than reducer keeps
    // the first-seen candidate, which is the documented stable behavior.
    const out = dedupeBySongIdentity(candidates, buildTrack(1996));
    expect(out[0].recordingId).toBe("old");
  });

  it("picks the earliest representative when the track has no year", () => {
    const candidates = [
      buildCandidate({ recordingId: "remaster", year: 2017 }),
      buildCandidate({ recordingId: "original", year: 1997 }),
      buildCandidate({ recordingId: "live", year: 2008 }),
    ];
    const out = dedupeBySongIdentity(candidates, buildTrack());
    expect(out).toHaveLength(1);
    expect(out[0].recordingId).toBe("original");
  });

  it("treats candidates without a year as effectively infinite distance / latest", () => {
    const candidates = [
      buildCandidate({ recordingId: "no-year" }),
      buildCandidate({ recordingId: "1997", year: 1997 }),
    ];
    const withYearTrack = dedupeBySongIdentity(candidates, buildTrack(1996));
    expect(withYearTrack[0].recordingId).toBe("1997");

    const noYearTrack = dedupeBySongIdentity(candidates, buildTrack());
    // earliest wins; the candidate without a year ranks as +Infinity, so 1997 wins.
    expect(noYearTrack[0].recordingId).toBe("1997");
  });

  it("returns input verbatim when groups are all size 1", () => {
    const candidates = [
      buildCandidate({ recordingId: "a", title: "Song A" }),
      buildCandidate({ recordingId: "b", title: "Song B" }),
    ];
    const out = dedupeBySongIdentity(candidates, buildTrack());
    expect(out.map((c) => c.recordingId).sort()).toEqual(["a", "b"]);
  });

  it("returns empty for empty input", () => {
    expect(dedupeBySongIdentity([], buildTrack())).toEqual([]);
  });
});
