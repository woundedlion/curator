// Arm-coverage lock for the narrow accessors over the Enrichment and
// SpotifyMatch discriminated unions. Each accessor is exercised against
// EVERY status arm of its union so that adding or renaming an arm (or
// moving a field between arms) forces a deliberate update here rather
// than silently changing what the accessor returns.
//
// Invariants pinned (current types.ts):
//   - Enrichment.matched.candidates is REQUIRED (always an array).
//   - Enrichment.ambiguous.candidates is REQUIRED.
//   - Enrichment.failed.candidates is OPTIONAL (may be undefined).
//   - SpotifyMatch.matched.uri / .candidates are REQUIRED; previewUrl optional.
//   - SpotifyMatch.ambiguous.candidates REQUIRED; uri OPTIONAL.

import { describe, expect, it } from "vitest";
import type {
  Enrichment,
  MBCandidate,
  SpotifyCandidate,
  SpotifyMatch,
} from "../types";
import {
  getMbCandidates,
  getMbRecordingId,
  getSpotifyCandidates,
  getSpotifyPreviewUrl,
  getSpotifyUri,
} from "./trackAccessors";

const mbCandidate: MBCandidate = {
  recordingId: "rec-1",
  title: "T",
  artist: "A",
  score: 0.9,
};

const spotifyCandidate: SpotifyCandidate = {
  uri: "spotify:track:aaaaaaaaaaaaaaaaaaaaaa",
  id: "aaaaaaaaaaaaaaaaaaaaaa",
  title: "T",
  artist: "A",
  score: 0.9,
};

// --- SpotifyMatch arms, reused across the SpotifyMatch accessors -----------

const spotifyArms: Record<SpotifyMatch["status"], SpotifyMatch> = {
  idle: { status: "idle" },
  pending: { status: "pending" },
  missing: { status: "missing" },
  matched: {
    status: "matched",
    uri: "spotify:track:matcheduri000000000000",
    candidates: [spotifyCandidate],
    score: 1,
    previewUrl: "https://example.test/preview.mp3",
  },
  ambiguous: {
    status: "ambiguous",
    candidates: [spotifyCandidate],
    score: 0.6,
    uri: "spotify:track:ambiguousuri0000000000",
  },
};

// --- Enrichment arms, reused across the Enrichment accessors ---------------

const enrichmentArms: Record<Enrichment["status"], Enrichment> = {
  idle: { status: "idle" },
  pending: { status: "pending" },
  matched: {
    status: "matched",
    mbRecordingId: "rec-matched",
    score: 1,
    candidates: [mbCandidate],
  },
  ambiguous: {
    status: "ambiguous",
    candidates: [mbCandidate],
    score: 0.6,
  },
  failed: {
    status: "failed",
    candidates: [mbCandidate],
  },
};

describe("getSpotifyUri — every SpotifyMatch arm", () => {
  it.each([
    ["matched", spotifyArms.matched, "spotify:track:matcheduri000000000000"],
    [
      "ambiguous (carries optional uri)",
      spotifyArms.ambiguous,
      "spotify:track:ambiguousuri0000000000",
    ],
    ["idle", spotifyArms.idle, undefined],
    ["pending", spotifyArms.pending, undefined],
    ["missing", spotifyArms.missing, undefined],
  ])("%s", (_label, match, expected) => {
    expect(getSpotifyUri(match)).toBe(expected);
  });

  it("ambiguous WITHOUT a uri returns undefined", () => {
    const ambiguousNoUri: SpotifyMatch = {
      status: "ambiguous",
      candidates: [spotifyCandidate],
      score: 0.6,
    };
    expect(getSpotifyUri(ambiguousNoUri)).toBeUndefined();
  });
});

describe("getSpotifyPreviewUrl — every SpotifyMatch arm", () => {
  it.each([
    [
      "matched (with previewUrl)",
      spotifyArms.matched,
      "https://example.test/preview.mp3",
    ],
    ["ambiguous", spotifyArms.ambiguous, undefined],
    ["idle", spotifyArms.idle, undefined],
    ["pending", spotifyArms.pending, undefined],
    ["missing", spotifyArms.missing, undefined],
  ])("%s", (_label, match, expected) => {
    expect(getSpotifyPreviewUrl(match)).toBe(expected);
  });

  it("matched WITHOUT a previewUrl returns undefined", () => {
    const matchedNoPreview: SpotifyMatch = {
      status: "matched",
      uri: "spotify:track:matcheduri000000000000",
      candidates: [],
      score: 1,
    };
    expect(getSpotifyPreviewUrl(matchedNoPreview)).toBeUndefined();
  });
});

describe("getSpotifyCandidates — every SpotifyMatch arm", () => {
  it("matched returns the candidate array", () => {
    expect(getSpotifyCandidates(spotifyArms.matched)).toEqual([
      spotifyCandidate,
    ]);
  });
  it("ambiguous returns the candidate array", () => {
    expect(getSpotifyCandidates(spotifyArms.ambiguous)).toEqual([
      spotifyCandidate,
    ]);
  });
  it.each([
    ["idle", spotifyArms.idle],
    ["pending", spotifyArms.pending],
    ["missing", spotifyArms.missing],
  ])("%s returns undefined", (_label, match) => {
    expect(getSpotifyCandidates(match)).toBeUndefined();
  });

  it("matched with an EMPTY candidate array returns [] (not undefined)", () => {
    const matchedEmpty: SpotifyMatch = {
      status: "matched",
      uri: "spotify:track:matcheduri000000000000",
      candidates: [],
      score: 1,
    };
    expect(getSpotifyCandidates(matchedEmpty)).toEqual([]);
  });
});

describe("getMbRecordingId — every Enrichment arm", () => {
  it.each([
    ["matched", enrichmentArms.matched, "rec-matched"],
    ["ambiguous", enrichmentArms.ambiguous, undefined],
    ["failed", enrichmentArms.failed, undefined],
    ["idle", enrichmentArms.idle, undefined],
    ["pending", enrichmentArms.pending, undefined],
  ])("%s", (_label, enrichment, expected) => {
    expect(getMbRecordingId(enrichment)).toBe(expected);
  });
});

describe("getMbCandidates — every Enrichment arm", () => {
  it("matched returns the candidate array (required, possibly empty)", () => {
    expect(getMbCandidates(enrichmentArms.matched)).toEqual([mbCandidate]);
  });
  it("ambiguous returns the candidate array", () => {
    expect(getMbCandidates(enrichmentArms.ambiguous)).toEqual([mbCandidate]);
  });
  it("failed WITH candidates returns them", () => {
    expect(getMbCandidates(enrichmentArms.failed)).toEqual([mbCandidate]);
  });
  it("failed WITHOUT candidates returns undefined (optional arm)", () => {
    const failedNoCandidates: Enrichment = { status: "failed" };
    expect(getMbCandidates(failedNoCandidates)).toBeUndefined();
  });
  it.each([
    ["idle", enrichmentArms.idle],
    ["pending", enrichmentArms.pending],
  ])("%s returns undefined", (_label, enrichment) => {
    expect(getMbCandidates(enrichment)).toBeUndefined();
  });

  it("matched with an EMPTY candidate array returns [] (not undefined)", () => {
    const matchedEmpty: Enrichment = {
      status: "matched",
      mbRecordingId: "rec-x",
      score: 1,
      candidates: [],
    };
    expect(getMbCandidates(matchedEmpty)).toEqual([]);
  });
});
