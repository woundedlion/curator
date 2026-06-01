import {
  RequestCancelledError,
  SpotifyAuthExpiredError,
  SpotifyForbiddenError,
  SpotifyRateLimitError,
} from "../spotify/apiClient";
import { searchSpotifyForTrack } from "../spotify/spotifySearch";
import { spotifyDisplayFieldsFromCandidate } from "../spotify/spotifyMappers";
import { usePlaylistStore } from "../store/playlistStore";
import { useSettingsStore } from "../store/settingsStore";
import { useSpotifyStore } from "../store/spotifyStore";
import { useUiStore } from "../store/uiStore";
import type { SpotifyMatch } from "../types";

// Per-batch first-error tracking. Each batch (matchAll / rematch) owns its
// own flag so two concurrent batches don't share state — the previous
// module-level boolean would silently drop the second batch's errors.
// Returns whether THIS call was the first error of the batch, so the
// caller can gate its own per-track console output to a single line:
// under a rate-limit storm every track fails, and logging each one buries
// the one signal that matters in N identical lines.
type ErrorReporter = (error: unknown) => boolean;

function createErrorReporter(): ErrorReporter {
  let reported = false;
  return (error: unknown) => {
    if (reported) return false;
    reported = true;
    const ui = useUiStore.getState();
    if (error instanceof SpotifyAuthExpiredError) {
      ui.pushToast({
        kind: "error",
        message: "Spotify session expired — reconnect in Settings",
      });
      return true;
    }
    if (error instanceof SpotifyRateLimitError) {
      ui.pushToast({
        kind: "error",
        message:
          "Spotify rate limit hit too many times — wait a minute, then re-enrich",
      });
      return true;
    }
    if (error instanceof SpotifyForbiddenError) {
      // Mirror ingestController's import 403 guidance so a search 403 (region
      // restriction, missing scope, app not allow-listed) surfaces an
      // actionable message instead of the raw `Spotify 403 on /search: …`
      // body via the generic branch below.
      ui.pushToast({
        kind: "error",
        message:
          "Spotify denied the search (403) — verify your app's scopes and redirect URI in Settings, then reconnect",
      });
      return true;
    }
    const detail = error instanceof Error ? error.message : "see console";
    ui.pushToast({
      kind: "error",
      message: `Spotify search failed: ${detail}`,
    });
    return true;
  };
}

function markPending(trackId: string): void {
  const track = usePlaylistStore.getState().tracksById[trackId];
  if (!track) return;
  // matchOne only enters here from spotify.status === "idle", so the
  // prior state has no candidates to preserve.
  usePlaylistStore.getState().updateTrack(trackId, {
    spotify: { status: "pending" },
  });
}

async function matchOne(
  trackId: string,
  reportFirstError: ErrorReporter,
): Promise<void> {
  const settings = useSettingsStore.getState().settings;
  const clientId = settings.spotifyClientId;
  if (!clientId) return;

  const track = usePlaylistStore.getState().tracksById[trackId];
  if (!track) return;
  if (track.source.kind === "spotify-import") return;
  // Skip every non-idle status. Each resolved status represents a
  // decision the system has already made (or is making):
  //   - matched   : already chose a URI.
  //   - ambiguous : waiting for the user to pick a version.
  //   - missing   : Spotify already said no — re-asking burns quota
  //                 and yields the same answer.
  //   - pending   : an earlier matchOne is still in flight.
  // Only `idle` rows are truly unknown and worth queueing. The
  // per-row ↻ explicitly resets status to `idle` before calling
  // rematchOnSpotify, so this filter doesn't block intentional
  // user-driven re-searches.
  if (track.spotify.status !== "idle") return;

  markPending(trackId);

  const market = useSpotifyStore.getState().user?.country;
  // Defense-in-depth guard: re-evaluated when the queued task pops.
  // If the track was removed while we were in pending, abort cleanly
  // before sending the request. cancelSpotifyRequestsByTag(trackId)
  // is the primary cancellation path; this guard catches anything
  // it might miss (a deletion that fired after the task already
  // shifted out of pending, an orchestrator path that forgot to
  // call the cancel hook, etc.).
  const stillAlive = () =>
    Boolean(usePlaylistStore.getState().tracksById[trackId]);
  try {
    const match = await searchSpotifyForTrack(track, clientId, market, {
      guard: stillAlive,
    });

    // Re-read inside the store before writing back. The captured `track`
    // snapshot is stale relative to anything that interleaved during the
    // (multi-second) search; the pending-status guard below is what makes
    // the write safe, not the snapshot.
    const store = usePlaylistStore.getState();
    const liveTrack = store.tracksById[trackId];
    if (!liveTrack) return;

    // Drop late results that arrive after a reset. matchOne set
    // spotify.status = "pending" via markPending; if the live status is
    // anything else by the time we resume, something else has touched
    // the row — most commonly nukeEnrichmentState (which cancels
    // QUEUED tasks but cannot abort IN-FLIGHT HTTP calls; the network
    // response can still land here after the row was reset to idle).
    // Without this guard, the late response would silently rewrite a
    // nuked row back to matched/ambiguous/missing.
    if (liveTrack.spotify.status !== "pending") return;

    // A Spotify match IS the row's displayed identity (DESIGN §4.3 / the
    // source-of-truth rule): for a `matched` outcome, OVERWRITE the
    // displayed fields with the chosen candidate's, exactly as the manual
    // picker does (spotifyPicker.applyCandidateToTrack). Filling-missing
    // here instead would let a stale ID3 title outlive the match —
    // displaying a different song than the URI that will actually play.
    // For `ambiguous`/`missing`, displayFieldsFromMatch returns {} so only
    // the spotify state changes: those statuses must NOT overwrite the
    // displayed fields (a decision is still pending in the picker).
    const displayFields = displayFieldsFromMatch(match);
    store.updateTrack(trackId, { ...displayFields, spotify: match });
  } catch (error) {
    // Track was deleted (or the playlist was cleared) while the
    // search was queued. The row no longer exists, so there's
    // nothing to update and nothing to toast. updateTrack would be
    // a no-op anyway but skipping is clearer.
    if (error instanceof RequestCancelledError) return;
    // A bare AbortError can surface if the in-flight fetch was aborted by a
    // path that didn't route through the queue's cancel→RequestCancelledError
    // translation (or, post-timeout-wiring, a controller abort that lost the
    // race). Treat it as cancellation too: don't toast it, don't mark the row
    // `missing` — the row is being torn down or retried.
    if (error instanceof Error && error.name === "AbortError") return;
    // Only log the FIRST failure of the batch to the console. The toast
    // is already deduped to one per batch by the reporter; mirroring that
    // for the console keeps a rate-limit storm (every track 429s) from
    // printing N identical lines and burying the single real signal.
    // Subsequent failures still flow through the reporter (which no-ops
    // after the first) so user-facing behavior is unchanged.
    const wasFirstError = reportFirstError(error);
    if (wasFirstError) {
      console.error("Spotify match failed", { trackId, error });
    }
    // Same late-result guard as the success path. A nuke between
    // markPending and the failing response means the row is back at
    // idle; writing "missing" here would silently un-do the nuke.
    const postLive = usePlaylistStore.getState().tracksById[trackId];
    if (!postLive || postLive.spotify.status !== "pending") return;
    // Transient failures (rate limit, expired auth) are NOT "no match
    // on Spotify" — they mean we couldn't even ask. Reverting to
    // `idle` keeps the row eligible for re-enrich-all once the
    // circuit closes, instead of leaving it stuck in `missing` and
    // excluded from publishes. (The gate above ensures only idle rows
    // entered matchOne in the first place.)
    const isTransient =
      error instanceof SpotifyRateLimitError ||
      error instanceof SpotifyAuthExpiredError;
    usePlaylistStore.getState().updateTrack(trackId, {
      spotify: { status: isTransient ? "idle" : "missing" },
    });
  }
}

function displayFieldsFromMatch(match: SpotifyMatch) {
  if (match.status !== "matched" || !match.uri) return {};
  const chosen = match.candidates?.find((candidate) => candidate.uri === match.uri);
  if (!chosen) return {};
  return spotifyDisplayFieldsFromCandidate(chosen);
}

export async function matchAllOnSpotify(
  scope?: ReadonlySet<string>,
): Promise<void> {
  const reportFirstError = createErrorReporter();
  const allTrackIds = usePlaylistStore.getState().playlist.trackIds;
  const trackIds = scope
    ? allTrackIds.filter((id) => scope.has(id))
    : allTrackIds;
  // No producer-side limiter: the apiClient's IntervalQueue paces every
  // request at MIN_REQUEST_SPACING_MS (334 ms), so concurrent matchOne
  // calls all serialize at the pacer anyway. Capping producer parallelism
  // doesn't change throughput.
  await Promise.all(
    trackIds.map((id) => matchOne(id, reportFirstError)),
  );
}

export async function rematchOnSpotify(trackId: string): Promise<void> {
  await matchOne(trackId, createErrorReporter());
}

// Re-enrich flows (per-row ↻ and "Re-enrich all") want the Spotify search
// to redo from scratch, not short-circuit on the existing "matched"
// status. Reset the row's Spotify state to `idle` so the next matchOne
// call runs the search again. spotify-imported rows are skipped: their
// URI is the source of truth (matchOne refuses to touch them anyway) and
// blanking the status would just leave a confusing glyph for one frame.
export function resetSpotifyStatusForRefresh(trackId: string): void {
  const track = usePlaylistStore.getState().tracksById[trackId];
  if (!track) return;
  if (track.source.kind === "spotify-import") return;
  usePlaylistStore.getState().updateTrack(trackId, {
    spotify: { status: "idle" },
  });
}

// Promotes already-stored ambiguous Spotify matches that have exactly one
// candidate to "matched". Brings older playlists in line with the
// auto-select-single-candidate behavior without re-hitting the API.
// Displayed fields are filled only when missing — a user edit made between
// the original search and this promotion must survive (DESIGN §4.3
// source-of-truth: user edit wins).
export function promoteSingleCandidateMatches(): void {
  const store = usePlaylistStore.getState();
  for (const trackId of store.playlist.trackIds) {
    const track = store.tracksById[trackId];
    if (!track) continue;
    const { spotify } = track;
    // Only ambiguous rows can be promoted — matched is already there,
    // idle/pending/missing have no candidate list to read.
    if (spotify.status !== "ambiguous") continue;
    if (spotify.candidates.length !== 1) continue;
    const only = spotify.candidates[0]!;
    store.fillMissingDisplayFields(
      trackId,
      spotifyDisplayFieldsFromCandidate(only),
    );
    store.updateTrack(trackId, {
      spotify: {
        status: "matched",
        uri: only.uri,
        candidates: spotify.candidates,
        score: only.score,
        previewUrl: only.previewUrl,
      },
    });
  }
}
