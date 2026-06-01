import Fuse, { type IFuseOptions } from "fuse.js";
import type { MBCandidate, Track } from "../types";
import { normalizeForMatching } from "../metadata/normalizers";

type Scorable = {
  title: string;
  artist: string;
  album: string;
};

// Documented field split (DESIGN §4.3): title 0.50 · artist 0.30 ·
// album 0.15 · year 0.05.
//
// IMPORTANT — load-bearing invariant: Fuse.js internally normalizes the
// `keys[].weight` array to sum to 1, so the raw 0.50/0.30/0.15 below are
// rescaled to 0.526/0.316/0.158 inside Fuse. We then multiply the whole
// Fuse component by (1 - YEAR_WEIGHT) and add the year credit. The realized
// aggregate split equals the documented 0.50/0.30/0.15/0.05 EXACTLY — but
// only because `title + artist + album === 1 - YEAR_WEIGHT` (0.95). If you
// retune a field weight, preserve that identity or the documented contract
// silently drifts. `FIELD_WEIGHT_SUM_INVARIANT` (asserted in the tests)
// guards against an accidental break.
const FIELD_WEIGHTS = { title: 0.5, artist: 0.3, album: 0.15 } as const;
const YEAR_WEIGHT = 0.05;
const YEAR_FULL_CREDIT_YEARS = 1;
const YEAR_HALF_CREDIT_YEARS = 3;

// Exported for the invariant test: the field weights must sum to
// (1 - YEAR_WEIGHT) for the realized aggregate split to match DESIGN §4.3.
export const SCORER_FIELD_WEIGHTS = FIELD_WEIGHTS;
export const SCORER_YEAR_WEIGHT = YEAR_WEIGHT;

// Fuse options are a frozen constant; the instance itself is built
// per-call (below) over that call's candidate list. MB returns a small
// working set (MB_SEARCH_LIMIT, dedup'd further), so the constructor
// cost is negligible — and a per-call instance removes the shared
// mutable-collection hazard entirely: there is no module-level state a
// concurrent scoring pass could swap out from under `search`, so the
// `refIndex → score` mapping can never be corrupted by interleaving.
const FUSE_OPTIONS: IFuseOptions<Scorable> = {
  includeScore: true,
  keys: [
    { name: "title", weight: FIELD_WEIGHTS.title },
    { name: "artist", weight: FIELD_WEIGHTS.artist },
    { name: "album", weight: FIELD_WEIGHTS.album },
  ],
  threshold: 1,
  ignoreLocation: true,
};

function yearCredit(candidateYear?: number, trackYear?: number): number {
  if (typeof candidateYear !== "number" || typeof trackYear !== "number") return 0;
  const delta = Math.abs(candidateYear - trackYear);
  if (delta <= YEAR_FULL_CREDIT_YEARS) return 1;
  if (delta <= YEAR_HALF_CREDIT_YEARS) return 0.5;
  return 0;
}

function buildFuseTarget(candidate: MBCandidate): Scorable {
  // `year` is intentionally NOT a Fuse field — Fuse never reads it (it's
  // not in `keys`); year is scored separately via `yearCredit`. Putting it
  // on the target object was dead data.
  return {
    title: normalizeForMatching(candidate.title),
    artist: normalizeForMatching(candidate.artist),
    album: normalizeForMatching(candidate.album),
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

  // Build the Fuse query from ONLY the non-empty normalized fields. Fuse
  // treats an object query as a logical AND across its keys, and an
  // empty-string sub-query matches nothing — so including `album: ""`
  // (every text-source / album-less track) or `artist: ""` (a title-only
  // `.txt` line) makes `fuse.search` return `[]`, collapsing every
  // candidate's fuseScore to 0 and silently reducing ranking to year-only.
  // Omitting empty keys preserves the documented field weights for the
  // fields we actually have. (Verified: the per-key weights still apply to
  // partial queries.)
  const query: Partial<Scorable> = {};
  const queryTitle = normalizeForMatching(track.title);
  const queryArtist = normalizeForMatching(track.artist);
  const queryAlbum = normalizeForMatching(track.album);
  if (queryTitle) query.title = queryTitle;
  if (queryArtist) query.artist = queryArtist;
  if (queryAlbum) query.album = queryAlbum;

  const fuse = new Fuse<Scorable>(candidates.map(buildFuseTarget), FUSE_OPTIONS);

  const fuseScoresByIndex = new Map<number, number>();
  // No non-empty query fields → no text signal; leave all fuseScores at 0
  // and let year credit alone order the candidates (an empty `search({})`
  // returns nothing anyway, so guarding here just makes the intent explicit).
  if (queryTitle || queryArtist || queryAlbum) {
    for (const result of fuse.search(query)) {
      fuseScoresByIndex.set(result.refIndex, fuseDistanceToScore(result.score));
    }
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
