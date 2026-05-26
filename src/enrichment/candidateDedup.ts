import { normalizeForMatching } from "../metadata/normalizers";
import type { MBCandidate, Track } from "../types";

const OPEN_END_YEAR = Number.POSITIVE_INFINITY;

function songIdentityKey(candidate: MBCandidate): string {
  return `${normalizeForMatching(candidate.title)}|${normalizeForMatching(candidate.artist)}`;
}

function yearDistanceFrom(target: number, candidate: MBCandidate): number {
  if (candidate.year === undefined) return OPEN_END_YEAR;
  return Math.abs(candidate.year - target);
}

function pickClosestYear(
  group: MBCandidate[],
  targetYear: number,
): MBCandidate {
  return group.reduce((best, current) => {
    const bestDelta = yearDistanceFrom(targetYear, best);
    const currentDelta = yearDistanceFrom(targetYear, current);
    return currentDelta < bestDelta ? current : best;
  });
}

function pickEarliest(group: MBCandidate[]): MBCandidate {
  return group.reduce((best, current) => {
    const bestYear = best.year ?? OPEN_END_YEAR;
    const currentYear = current.year ?? OPEN_END_YEAR;
    return currentYear < bestYear ? current : best;
  });
}

function pickRepresentative(
  group: MBCandidate[],
  track: Track,
): MBCandidate {
  if (group.length === 1) return group[0];
  if (typeof track.year === "number") {
    return pickClosestYear(group, track.year);
  }
  return pickEarliest(group);
}

export function dedupeBySongIdentity(
  candidates: MBCandidate[],
  track: Track,
): MBCandidate[] {
  const groups = new Map<string, MBCandidate[]>();
  for (const candidate of candidates) {
    const key = songIdentityKey(candidate);
    const existing = groups.get(key);
    if (existing) existing.push(candidate);
    else groups.set(key, [candidate]);
  }
  return Array.from(groups.values()).map((group) =>
    pickRepresentative(group, track),
  );
}
