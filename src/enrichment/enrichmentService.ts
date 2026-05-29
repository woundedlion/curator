import type { MBCandidate, Track } from "../types";
import {
  cacheKeyForTrack,
  readCachedCandidates,
  writeCachedCandidates,
} from "../db/musicbrainzCache";
import { dedupeBySongIdentity } from "./candidateDedup";
import { scoreCandidates } from "./candidateScorer";
import { buildRecordingQuery } from "./luceneQuery";
import { searchRecordings } from "./musicbrainzClient";
import {
  MIN_AUTO_MATCH_TITLE_SIMILARITY,
  titleSimilarity,
} from "./titleSimilarity";

export type EnrichmentOutcome = {
  status: "matched" | "ambiguous" | "failed";
  candidates: MBCandidate[];
  topScore: number;
  recordingId?: string;
  failureReason?: "no-query" | "no-results";
};

function classifyOutcome(
  scored: MBCandidate[],
  track: Track,
  acceptThreshold: number,
): EnrichmentOutcome {
  const best = scored[0];
  if (!best) {
    return {
      status: "failed",
      candidates: [],
      topScore: 0,
      failureReason: "no-results",
    };
  }
  const scoreOk = best.score >= acceptThreshold;
  const titleOk = fieldLooksSimilar(track.title, best.title);
  const artistOk = fieldLooksSimilar(track.artist, best.artist);
  if (scoreOk && titleOk && artistOk) {
    return {
      status: "matched",
      candidates: scored,
      topScore: best.score,
      recordingId: best.recordingId,
    };
  }
  return { status: "ambiguous", candidates: scored, topScore: best.score };
}

function fieldLooksSimilar(
  userValue: string | undefined,
  candidateValue: string | undefined,
): boolean {
  if (userValue === undefined) return true;
  return (
    titleSimilarity(userValue, candidateValue) >=
    MIN_AUTO_MATCH_TITLE_SIMILARITY
  );
}

function altQueryDiffers(
  primary: { title?: string; artist?: string },
  alt: { title?: string; artist?: string },
): boolean {
  return (
    primary.title?.toLowerCase().trim() !==
      alt.title?.toLowerCase().trim() ||
    primary.artist?.toLowerCase().trim() !==
      alt.artist?.toLowerCase().trim()
  );
}

function mergeCandidatesPreferringPrimary(
  primary: MBCandidate[],
  alternate: MBCandidate[],
): MBCandidate[] {
  const seen = new Set<string>();
  const merged: MBCandidate[] = [];
  for (const candidate of [...primary, ...alternate]) {
    if (seen.has(candidate.recordingId)) continue;
    seen.add(candidate.recordingId);
    merged.push(candidate);
  }
  return merged;
}

async function fetchAndScore(
  queryFields: { title?: string; artist?: string; album?: string },
  track: Track,
  contactEmail: string,
  guard: (() => boolean) | undefined,
): Promise<MBCandidate[]> {
  const query = buildRecordingQuery(queryFields);
  if (!query) return [];
  const fetched = await searchRecordings(query, contactEmail, {
    tag: track.id,
    guard,
  });
  const deduped = dedupeBySongIdentity(fetched, track);
  return scoreCandidates(track, deduped);
}

export type EnrichTrackOptions = {
  bypassCache?: boolean;
  /**
   * Defense-in-depth guard. When the queued MB lookup pops, the
   * guard is re-evaluated; returning false rejects the queued task
   * with RequestCancelledError without firing the HTTP call. Pair
   * with `cancelMusicbrainzRequestsByTag(track.id)` on the deletion
   * side for layered protection.
   */
  guard?: () => boolean;
};

export async function enrichTrack(
  track: Track,
  contactEmail: string,
  acceptThreshold: number,
  options: EnrichTrackOptions = {},
): Promise<EnrichmentOutcome> {
  const cacheKey = cacheKeyForTrack(track);
  const primaryFields = {
    title: track.title,
    artist: track.artist,
    album: track.album,
  };

  // Cache hit substitutes for the primary FETCH only — it does NOT
  // short-circuit the rest of the function. A track first enriched
  // without an altQuery (or before altQuery was derived) would
  // otherwise get a permanently degraded match: every subsequent
  // re-enrich would early-return on the cache hit and the altQuery
  // would never fire. The cost is at most one extra MB request per
  // re-enrich of an alt-query-bearing track that fell below the
  // accept threshold on cache — bounded by the rate-limit queue and
  // gated by `shouldTryAlt` below (only runs when primary didn't
  // auto-match and altQuery actually differs from the primary).
  let primaryScored: MBCandidate[] | null = null;
  let cacheHit = false;
  if (!options.bypassCache) {
    const cached = await readCachedCandidates(cacheKey);
    if (cached.kind === "cached" && cached.candidates.length > 0) {
      primaryScored = scoreCandidates(track, cached.candidates);
      cacheHit = true;
    }
  }
  if (primaryScored === null) {
    primaryScored = await fetchAndScore(
      primaryFields,
      track,
      contactEmail,
      options.guard,
    );
  }
  let outcome = classifyOutcome(primaryScored, track, acceptThreshold);

  const shouldTryAlt =
    outcome.status !== "matched" &&
    track.altQuery !== undefined &&
    altQueryDiffers(primaryFields, track.altQuery);

  if (shouldTryAlt && track.altQuery) {
    const altScoringTrack: Track = {
      ...track,
      title: track.altQuery.title ?? track.title,
      artist: track.altQuery.artist ?? track.artist,
    };
    const altScored = await fetchAndScore(
      {
        title: track.altQuery.title,
        artist: track.altQuery.artist,
      },
      altScoringTrack,
      contactEmail,
      options.guard,
    );
    // Asymmetric-scoring note: primary candidates retain the score they
    // got against `track`; alt candidates retain theirs against
    // `altScoringTrack`. We do NOT re-score because (a) each batch's
    // ranking is meaningful against its own query, and (b) re-scoring
    // would penalize primary hits that *are* good matches for the
    // unmodified track fields. We DO re-sort the merged list by score:
    // without this, classifyOutcome picks merged[0] (primary's first
    // result), burying a higher-scoring alt candidate behind a worse
    // primary one — the alt branch only runs when primary failed the
    // threshold, so primary's top is by definition not strong enough
    // to defend its position against alt.
    const mergedCandidates = mergeCandidatesPreferringPrimary(primaryScored, altScored)
      .slice()
      .sort((a, b) => b.score - a.score);
    outcome = classifyOutcome(mergedCandidates, altScoringTrack, acceptThreshold);
  }

  // The cache is keyed on the **primary** (title, artist, album) — so it
  // must store only candidates that the primary query produced. If we
  // wrote `mergedCandidates` here, alt-query-derived recordings would
  // leak into a future enrichment of any *other* track that shares this
  // primary identity. The alt query is a per-track-altQuery effort and
  // re-runs on cache miss anyway. Skip the rewrite when we read from
  // cache — `primaryScored` is byte-equal to what's already there, so
  // the write is a no-op modulo cachedAt churn.
  if (primaryScored.length > 0 && !cacheHit) {
    await writeCachedCandidates(cacheKey, primaryScored);
  } else if (
    outcome.status === "failed" &&
    primaryFields.title === undefined &&
    primaryFields.artist === undefined &&
    !shouldTryAlt
  ) {
    // True "no-query": primary had nothing to query AND alt either
    // doesn't exist or matches primary (so it also had nothing). When
    // alt did run, defer to its outcome (no-results / ambiguous /
    // matched) rather than clobbering it.
    return {
      status: "failed",
      candidates: [],
      topScore: 0,
      failureReason: "no-query",
    };
  }
  return outcome;
}
