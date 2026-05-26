import type { MBCandidate, Track } from "../types";
import {
  readCachedCandidates,
  writeCachedCandidates,
} from "../db/musicbrainzCache";
import { dedupeBySongIdentity } from "./candidateDedup";
import { scoreCandidates } from "./candidateScorer";
import { buildRecordingQuery } from "./luceneQuery";
import { normalizeForMatching } from "../metadata/normalizers";
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

function cacheKeyForTrack(track: Track) {
  return {
    title: normalizeForMatching(track.title),
    artist: normalizeForMatching(track.artist),
    album: normalizeForMatching(track.album),
  };
}

function classifyOutcome(
  scored: MBCandidate[],
  track: Track,
  acceptThreshold: number,
): EnrichmentOutcome {
  if (scored.length === 0) {
    return {
      status: "failed",
      candidates: [],
      topScore: 0,
      failureReason: "no-results",
    };
  }
  const [best] = scored;
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
): Promise<MBCandidate[]> {
  const query = buildRecordingQuery(queryFields);
  if (!query) return [];
  const fetched = await searchRecordings(query, contactEmail);
  const deduped = dedupeBySongIdentity(fetched, track);
  return scoreCandidates(track, deduped);
}

export async function enrichTrack(
  track: Track,
  contactEmail: string,
  acceptThreshold: number,
  options: { bypassCache?: boolean } = {},
): Promise<EnrichmentOutcome> {
  const cacheKey = cacheKeyForTrack(track);
  if (!options.bypassCache) {
    const cached = await readCachedCandidates(cacheKey);
    if (cached && cached.length > 0) {
      const scored = scoreCandidates(track, cached);
      return classifyOutcome(scored, track, acceptThreshold);
    }
  }

  const primaryFields = {
    title: track.title,
    artist: track.artist,
    album: track.album,
  };
  const primaryScored = await fetchAndScore(primaryFields, track, contactEmail);
  let outcome = classifyOutcome(primaryScored, track, acceptThreshold);
  let mergedCandidates = primaryScored;

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
    );
    mergedCandidates = mergeCandidatesPreferringPrimary(primaryScored, altScored);
    outcome = classifyOutcome(mergedCandidates, altScoringTrack, acceptThreshold);
  }

  // The cache is keyed on the **primary** (title, artist, album) — so it
  // must store only candidates that the primary query produced. If we
  // wrote `mergedCandidates` here, alt-query-derived recordings would
  // leak into a future enrichment of any *other* track that shares this
  // primary identity. The alt query is a per-track-altQuery effort and
  // re-runs on cache miss anyway.
  if (primaryScored.length > 0) {
    await writeCachedCandidates(cacheKey, primaryScored);
  } else if (primaryFields.title === undefined && primaryFields.artist === undefined) {
    return {
      status: "failed",
      candidates: [],
      topScore: 0,
      failureReason: "no-query",
    };
  }
  return outcome;
}
