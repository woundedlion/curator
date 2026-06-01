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

// Reference fields a candidate was actually scored against. Primary
// candidates carry the unmodified track fields; alt candidates carry
// the altQuery fields. classifyOutcome runs the similarity gate against
// the SAME reference a candidate's score was computed from — otherwise
// (merged primary+alt) the gate could judge an alt candidate against the
// primary's title and spuriously reject a legitimate match, or vice
// versa. We keep this as a side-table keyed by reference identity rather
// than widening MBCandidate (a persisted/cached type that must not gain
// a transient field).
type ScoringReference = { title?: string; artist?: string };

function classifyOutcome(
  scored: MBCandidate[],
  defaultReference: ScoringReference,
  acceptThreshold: number,
  referenceFor?: (candidate: MBCandidate) => ScoringReference,
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
  // Gate `best` against the reference it was scored against, not a
  // single global reference — keeps score and similarity coherent for
  // the merged primary+alt set.
  const reference = referenceFor ? referenceFor(best) : defaultReference;
  const scoreOk = best.score >= acceptThreshold;
  const titleOk = fieldLooksSimilar(reference.title, best.title);
  const artistOk = fieldLooksSimilar(reference.artist, best.artist);
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

// Takes the already-built Lucene query rather than re-deriving it from
// fields. buildRecordingQuery is invoked once per logical query in
// enrichTrack (primary + alt) and the result threaded through here — the
// old shape rebuilt the primary query inside fetchAndScore on top of the
// build(s) the alt-differs check already did, constructing the same
// string up to 3x per enrich for no behavioral gain.
async function fetchAndScore(
  query: string,
  track: Track,
  contactEmail: string,
  guard: (() => boolean) | undefined,
): Promise<MBCandidate[]> {
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
  // Build the primary Lucene query ONCE and reuse it for both the fetch
  // and the alt-differs comparison below. The old code rebuilt it inside
  // fetchAndScore AND twice inside altQueryDiffers — up to 3 identical
  // constructions per enrich. buildRecordingQuery normalizes (strips
  // parentheticals, `feat.`, diacritics, &→and), so the query string is
  // the canonical form to compare the alt query against.
  const primaryQuery = buildRecordingQuery(primaryFields);

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
      primaryQuery,
      track,
      contactEmail,
      options.guard,
    );
  }
  let outcome = classifyOutcome(primaryScored, track, acceptThreshold);
  // Primary candidates are scored against the unmodified track fields.
  const primaryReference: ScoringReference = {
    title: track.title,
    artist: track.artist,
  };

  // Build the alt query once too, then decide whether to run it by
  // comparing the two canonical query strings. An alt that differs from
  // the primary only by, say, a "(Live)" suffix collapses to the SAME
  // query — issuing it would burn a 1 req/sec MB slot on a byte-identical
  // request. `altQuery === undefined` ⇒ no alt query string to build.
  const altQuery =
    track.altQuery !== undefined
      ? buildRecordingQuery({
          title: track.altQuery.title,
          artist: track.altQuery.artist,
        })
      : "";
  const shouldTryAlt =
    outcome.status !== "matched" &&
    track.altQuery !== undefined &&
    altQuery !== primaryQuery;

  if (shouldTryAlt && track.altQuery) {
    const altScoringTrack: Track = {
      ...track,
      title: track.altQuery.title ?? track.title,
      artist: track.altQuery.artist ?? track.artist,
    };
    const altScored = await fetchAndScore(
      altQuery,
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
    // mergeCandidatesPreferringPrimary already returns a fresh array, so
    // sort it in place — no defensive copy needed.
    const mergedCandidates = mergeCandidatesPreferringPrimary(
      primaryScored,
      altScored,
    ).sort((a, b) => b.score - a.score);
    // Apples-to-apples classification: because scores were computed
    // against DIFFERENT references (primary vs altScoringTrack), the
    // similarity gate must compare each candidate against the SAME
    // reference its score came from. mergeCandidatesPreferringPrimary
    // keeps primary entries when a recordingId appears in both, so a
    // recordingId present in `primaryScored` is a primary candidate.
    // Without this, classifyOutcome would gate whatever sorts first
    // against `altScoringTrack`, which could reject a legitimate primary
    // match whose title is close to `track` but not to the altQuery.
    const altReference: ScoringReference = {
      title: track.altQuery.title ?? track.title,
      artist: track.altQuery.artist ?? track.artist,
    };
    const primaryIds = new Set(primaryScored.map((c) => c.recordingId));
    outcome = classifyOutcome(
      mergedCandidates,
      altReference,
      acceptThreshold,
      (candidate) =>
        primaryIds.has(candidate.recordingId) ? primaryReference : altReference,
    );
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
    // Treat empty/whitespace title+artist as "no query" too, not just
    // `undefined`: a blank-string field produces an empty Lucene query
    // exactly like a missing one, so both should classify as `no-query`
    // (not `no-results`).
    !primaryFields.title?.trim() &&
    !primaryFields.artist?.trim() &&
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
