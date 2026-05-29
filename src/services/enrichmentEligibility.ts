import type { Track } from "../types";

// Single source of truth for "does this track need MB enrichment?" The
// MB runner previously embedded two near-identical policies — one in
// `shouldSkipTrack` (the per-call gate inside the runner) and one in
// `isTrackPendingLookup` (the toolbar's "what counts as pending"). Both
// encoded the Spotify-source-of-truth rule and the userOverride opt-out,
// and any drift between them produced subtle bugs: the runner would
// enqueue tracks the toolbar said weren't pending, or vice versa. This
// module centralizes the decision.
//
// Two views on the same policy:
//
//   `shouldEnrichTrack`     — predicate the runner uses to gate each
//                             attempt. Truthy means "this track is
//                             eligible RIGHT NOW for an MB lookup
//                             pass": MB hasn't matched it yet, the user
//                             hasn't overridden enrichment, and (when
//                             Spotify is configured) Spotify has
//                             already resolved it as matched.
//
//   `isTrackPendingLookup`  — predicate the "re-enrich all" button uses
//                             to decide what to redo. Truthy means
//                             "this track has unfinished resolution
//                             work" — either Spotify hasn't even tried
//                             yet (idle) or Spotify resolved it but MB
//                             hasn't run. Resolved-decision states
//                             (Spotify ambiguous/missing, MB
//                             matched/ambiguous/failed) are left
//                             untouched.
//
// Both call into `isMbEnrichmentEligible` so the Spotify-gating and
// userOverride rule lives in one place.

function isMbEnrichmentEligible(
  track: Track,
  spotifyConfigured: boolean,
): "yes" | "no" | "needs-spotify-first" {
  if (track.enrichment.userOverride) return "no";
  if (track.enrichment.status === "matched") return "no";
  if (!spotifyConfigured) return "yes";
  // Spotify is source of truth: enrich only tracks Spotify confirmed.
  // Ambiguous tracks enrich after the user picks (via reenrichTrack
  // in spotifyPicker); missing tracks stay un-enriched.
  if (track.spotify.status === "matched") return "yes";
  return "needs-spotify-first";
}

/**
 * Per-call gate for the MB runner. Returns true when this trackId is
 * eligible to be enqueued for an MB lookup right now. The runner reads
 * this immediately before submitting; defense-in-depth guards inside
 * the queue body re-check at pop time.
 */
export function shouldEnrichTrack(
  track: Track | undefined,
  spotifyConfigured: boolean,
): boolean {
  if (!track) return false;
  return isMbEnrichmentEligible(track, spotifyConfigured) === "yes";
}

/**
 * "Re-enrich all" eligibility. A track is pending lookup when SOME
 * resolution step is still owed:
 *
 *   - For spotify-imported rows: Spotify identity is fixed by import,
 *     so the only owed step is MB. Idle MB → pending.
 *   - With Spotify NOT configured: same as above — only MB runs at all.
 *     Idle MB → pending.
 *   - With Spotify configured:
 *       Spotify idle               → pending (needs Spotify first).
 *       Spotify matched + MB idle  → pending (needs MB next).
 *       Anything else              → resolved (don't re-queue): ambiguous
 *                                    is waiting on the user's picker,
 *                                    missing means Spotify said no,
 *                                    matched-on-both is done.
 *
 * userOverride opts a row out of both, including spotify-imports — a
 * user who manually fixed the MB identity doesn't want re-enrich to
 * undo it.
 */
export function isTrackPendingLookup(
  track: Track,
  spotifyConfigured: boolean,
): boolean {
  if (track.enrichment.userOverride) return false;
  if (track.source.kind === "spotify-import") {
    return track.enrichment.status === "idle";
  }
  if (!spotifyConfigured) {
    return track.enrichment.status === "idle";
  }
  if (track.spotify.status === "idle") return true;
  if (
    track.spotify.status === "matched" &&
    track.enrichment.status === "idle"
  ) {
    return true;
  }
  return false;
}
