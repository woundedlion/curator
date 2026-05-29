// Narrow accessors over the discriminated unions in types.ts. These let
// consumers ask the questions they actually want ("does this row have a
// Spotify URI?", "did MB give us a recording id?") without re-deriving
// the status-arm narrowing at every call site.

import type {
  Enrichment,
  MBCandidate,
  SpotifyCandidate,
  SpotifyMatch,
} from "../types";

/**
 * URI of the row's Spotify identity, if any. Matched rows carry one by
 * definition; ambiguous rows may carry one when round-tripped from a
 * curator-export that recorded a prior pick.
 */
export function getSpotifyUri(match: SpotifyMatch): string | undefined {
  if (match.status === "matched") return match.uri;
  if (match.status === "ambiguous") return match.uri;
  return undefined;
}

/** 30-second preview URL — only present on matched rows. */
export function getSpotifyPreviewUrl(
  match: SpotifyMatch,
): string | undefined {
  return match.status === "matched" ? match.previewUrl : undefined;
}

/** MB recording id — only present on matched enrichment. */
export function getMbRecordingId(
  enrichment: Enrichment,
): string | undefined {
  return enrichment.status === "matched" ? enrichment.mbRecordingId : undefined;
}

/** MB candidate list — present on ambiguous, optional on matched/failed. */
export function getMbCandidates(
  enrichment: Enrichment,
): readonly MBCandidate[] | undefined {
  if (
    enrichment.status === "matched" ||
    enrichment.status === "failed"
  ) {
    return enrichment.candidates;
  }
  if (enrichment.status === "ambiguous") return enrichment.candidates;
  return undefined;
}

/** Spotify candidate list — present on matched/ambiguous only. */
export function getSpotifyCandidates(
  match: SpotifyMatch,
): readonly SpotifyCandidate[] | undefined {
  if (match.status === "matched" || match.status === "ambiguous") {
    return match.candidates;
  }
  return undefined;
}

/** `userOverride` — present on every enrichment arm but optional. */
export function getEnrichmentUserOverride(
  enrichment: Enrichment,
): boolean | undefined {
  return enrichment.userOverride;
}
