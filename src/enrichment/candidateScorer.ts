import Fuse from "fuse.js";
import type { MBCandidate, Track } from "../types";
import { normalizeForMatching } from "../metadata/normalizers";

type Scorable = {
  title: string;
  artist: string;
  album: string;
  year?: number;
};

const FIELD_WEIGHTS = { title: 0.5, artist: 0.3, album: 0.15 } as const;
const YEAR_WEIGHT = 0.05;
const YEAR_FULL_CREDIT_YEARS = 1;
const YEAR_HALF_CREDIT_YEARS = 3;

function yearCredit(candidateYear?: number, trackYear?: number): number {
  if (typeof candidateYear !== "number" || typeof trackYear !== "number") return 0;
  const delta = Math.abs(candidateYear - trackYear);
  if (delta <= YEAR_FULL_CREDIT_YEARS) return 1;
  if (delta <= YEAR_HALF_CREDIT_YEARS) return 0.5;
  return 0;
}

function buildFuseTarget(candidate: MBCandidate): Scorable {
  return {
    title: normalizeForMatching(candidate.title),
    artist: normalizeForMatching(candidate.artist),
    album: normalizeForMatching(candidate.album),
    year: candidate.year,
  };
}

function fuseDistanceToScore(distance: number | undefined): number {
  if (distance === undefined) return 0;
  return 1 - distance;
}

export function scoreCandidates(
  track: Track,
  candidates: MBCandidate[],
): MBCandidate[] {
  if (candidates.length === 0) return candidates;

  const query = {
    title: normalizeForMatching(track.title),
    artist: normalizeForMatching(track.artist),
    album: normalizeForMatching(track.album),
  };

  const fuse = new Fuse(candidates.map(buildFuseTarget), {
    includeScore: true,
    keys: [
      { name: "title", weight: FIELD_WEIGHTS.title },
      { name: "artist", weight: FIELD_WEIGHTS.artist },
      { name: "album", weight: FIELD_WEIGHTS.album },
    ],
    threshold: 1,
    ignoreLocation: true,
  });

  const fuseScoresByIndex = new Map<number, number>();
  for (const result of fuse.search(query)) {
    fuseScoresByIndex.set(result.refIndex, fuseDistanceToScore(result.score));
  }

  return candidates
    .map((candidate, index) => {
      const fuseScore = fuseScoresByIndex.get(index) ?? 0;
      const yearScore = yearCredit(candidate.year, track.year) * YEAR_WEIGHT;
      const combined = fuseScore * (1 - YEAR_WEIGHT) + yearScore;
      return { ...candidate, score: combined };
    })
    .sort((a, b) => b.score - a.score);
}
