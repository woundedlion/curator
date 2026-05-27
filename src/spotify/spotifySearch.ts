import Fuse from "fuse.js";
import {
  DEFAULT_ACCEPT_SPOTIFY_HIGH,
  SPOTIFY_AUTOPICK_GAP,
  SPOTIFY_SEARCH_LIMIT,
} from "../constants";
import type { SpotifyCandidate, SpotifyMatch, Track } from "../types";
import { normalizeForMatching } from "../metadata/normalizers";
import { callSpotify } from "./apiClient";
import type { SpotifySearchResponse } from "./dtos";
import { toSpotifyCandidate } from "./spotifyMappers";

type IdentifyingFields = { title?: string; artist?: string };

const FUSE_BLEND_WEIGHT = 0.8;
const YEAR_CREDIT_WEIGHT = 0.1;
const DURATION_CREDIT_WEIGHT = 0.1;

const YEAR_FULL_DELTA = 1;
const YEAR_HALF_DELTA = 3;
const DURATION_FULL_DELTA_MS = 2_000;
const DURATION_HALF_DELTA_MS = 10_000;

function escapeQuoted(value: string): string {
  return value.replace(/"/g, "");
}

function buildQueryString(fields: IdentifyingFields): string {
  const parts: string[] = [];
  if (fields.title) parts.push(`track:"${escapeQuoted(fields.title)}"`);
  if (fields.artist) parts.push(`artist:"${escapeQuoted(fields.artist)}"`);
  return parts.join(" ");
}

function primaryFieldsFromTrack(track: Track): IdentifyingFields {
  return { title: track.title, artist: track.artist };
}

function isQueryEquivalent(
  a: IdentifyingFields,
  b: IdentifyingFields,
): boolean {
  return (
    (a.title ?? "").toLowerCase().trim() === (b.title ?? "").toLowerCase().trim()
    && (a.artist ?? "").toLowerCase().trim() === (b.artist ?? "").toLowerCase().trim()
  );
}

function yearCredit(
  trackYear: number | undefined,
  candidateYear: number | undefined,
): number {
  if (typeof trackYear !== "number" || typeof candidateYear !== "number") return 0;
  const delta = Math.abs(trackYear - candidateYear);
  if (delta <= YEAR_FULL_DELTA) return 1;
  if (delta <= YEAR_HALF_DELTA) return 0.5;
  return 0;
}

function durationCredit(
  trackDurationMs: number | undefined,
  candidateDurationMs: number | undefined,
): number {
  if (
    typeof trackDurationMs !== "number" ||
    typeof candidateDurationMs !== "number"
  ) {
    return 0;
  }
  const delta = Math.abs(trackDurationMs - candidateDurationMs);
  if (delta <= DURATION_FULL_DELTA_MS) return 1;
  if (delta <= DURATION_HALF_DELTA_MS) return 0.5;
  return 0;
}

function scoreSpotifyCandidates(
  track: Track,
  candidates: SpotifyCandidate[],
): SpotifyCandidate[] {
  if (candidates.length === 0) return candidates;

  const fuse = new Fuse(
    candidates.map((candidate) => ({
      title: normalizeForMatching(candidate.title),
      artist: normalizeForMatching(candidate.artist),
      album: normalizeForMatching(candidate.album),
    })),
    {
      includeScore: true,
      keys: [
        { name: "title", weight: 0.5 },
        { name: "artist", weight: 0.3 },
        { name: "album", weight: 0.2 },
      ],
      threshold: 1,
      ignoreLocation: true,
    },
  );

  const query = {
    title: normalizeForMatching(track.title),
    artist: normalizeForMatching(track.artist),
    album: normalizeForMatching(track.album),
  };

  const fuseScoresByIndex = new Map<number, number>();
  for (const result of fuse.search(query)) {
    fuseScoresByIndex.set(result.refIndex, 1 - (result.score ?? 1));
  }

  return candidates
    .map((candidate, index) => {
      const fuseSim = fuseScoresByIndex.get(index) ?? 0;
      const yearSim = yearCredit(track.year, candidate.year);
      const durationSim = durationCredit(track.durationMs, candidate.durationMs);
      const combined =
        fuseSim * FUSE_BLEND_WEIGHT +
        yearSim * YEAR_CREDIT_WEIGHT +
        durationSim * DURATION_CREDIT_WEIGHT;
      return { ...candidate, score: combined };
    })
    .sort((a, b) => b.score - a.score);
}

function classifyMatch(scored: SpotifyCandidate[]): SpotifyMatch {
  // `missing` means Spotify returned zero candidates — the user has
  // nothing to pick from. When Spotify returned candidates but none
  // cleared the auto-pick threshold, the row is `ambiguous`: the user
  // can still pick one from the dialog. Conflating the two as "missing"
  // is misleading in the UI (the glyph implies a dead-end) and in the
  // filter (hideUnmatched would hide rows the user could resolve with
  // one click).
  if (scored.length === 0) return { status: "missing" };
  const [best, runnerUp] = scored;
  const onlyCandidate = scored.length === 1;
  const gap = runnerUp ? best.score - runnerUp.score : 1;
  if (
    onlyCandidate ||
    (best.score >= DEFAULT_ACCEPT_SPOTIFY_HIGH && gap >= SPOTIFY_AUTOPICK_GAP)
  ) {
    return {
      status: "matched",
      uri: best.uri,
      candidates: scored,
      score: best.score,
      previewUrl: best.previewUrl,
    };
  }
  return { status: "ambiguous", candidates: scored, score: best.score };
}

function mergeCandidatesPreferringPrimary(
  primary: SpotifyCandidate[],
  alternate: SpotifyCandidate[],
): SpotifyCandidate[] {
  const seen = new Set<string>();
  const merged: SpotifyCandidate[] = [];
  for (const candidate of [...primary, ...alternate]) {
    if (seen.has(candidate.id)) continue;
    seen.add(candidate.id);
    merged.push(candidate);
  }
  return merged;
}

async function fetchCandidatesForQuery(
  queryString: string,
  clientId: string,
  marketCountry: string | undefined,
): Promise<SpotifyCandidate[]> {
  if (!queryString) return [];
  const response = await callSpotify<SpotifySearchResponse>(
    {
      path: "/search",
      query: {
        q: queryString,
        type: "track",
        limit: SPOTIFY_SEARCH_LIMIT,
        market: marketCountry,
      },
    },
    clientId,
  );
  return (response.tracks?.items ?? []).map(toSpotifyCandidate);
}

export async function searchSpotifyForTrack(
  track: Track,
  clientId: string,
  marketCountry?: string,
): Promise<SpotifyMatch> {
  const primaryFields = primaryFieldsFromTrack(track);
  const primaryQuery = buildQueryString(primaryFields);
  if (!primaryQuery && !track.altQuery) return { status: "missing" };

  const primaryCandidates = await fetchCandidatesForQuery(
    primaryQuery,
    clientId,
    marketCountry,
  );

  let candidates = primaryCandidates;
  const altIsRedundant =
    !track.altQuery || isQueryEquivalent(primaryFields, track.altQuery);

  if (candidates.length === 0 && !altIsRedundant && track.altQuery) {
    const altQuery = buildQueryString(track.altQuery);
    if (altQuery) {
      const altCandidates = await fetchCandidatesForQuery(
        altQuery,
        clientId,
        marketCountry,
      );
      candidates = mergeCandidatesPreferringPrimary(
        primaryCandidates,
        altCandidates,
      );
    }
  }

  const scored = scoreSpotifyCandidates(track, candidates);
  return classifyMatch(scored);
}

export async function searchSpotifyCandidatesByFields(
  fields: IdentifyingFields,
  clientId: string,
  marketCountry?: string,
): Promise<SpotifyCandidate[]> {
  const queryString = buildQueryString(fields);
  if (!queryString) return [];
  return fetchCandidatesForQuery(queryString, clientId, marketCountry);
}
