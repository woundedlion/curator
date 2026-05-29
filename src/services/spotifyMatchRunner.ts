import { SPOTIFY_SEARCH_CONCURRENCY } from "../constants";
import {
  RequestCancelledError,
  SpotifyAuthExpiredError,
  SpotifyRateLimitError,
} from "../spotify/apiClient";
import { ConcurrencyLimiter } from "../spotify/concurrencyLimiter";
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
type ErrorReporter = (error: unknown) => void;

function createErrorReporter(): ErrorReporter {
  let reported = false;
  return (error: unknown) => {
    if (reported) return;
    reported = true;
    const ui = useUiStore.getState();
    if (error instanceof SpotifyAuthExpiredError) {
      ui.pushToast({
        kind: "error",
        message: "Spotify session expired — reconnect in Settings",
      });
      return;
    }
    if (error instanceof SpotifyRateLimitError) {
      ui.pushToast({
        kind: "error",
        message:
          "Spotify rate limit hit too many times — wait a minute, then re-enrich",
      });
      return;
    }
    const detail = error instanceof Error ? error.message : "see console";
    ui.pushToast({
      kind: "error",
      message: `Spotify search failed: ${detail}`,
    });
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

    // Re-read inside the store before writing back. When the user edits
    // a track's title/artist while the Spotify search is in flight, the
    // captured `track` snapshot is stale; the store-level fill action
    // refuses to clobber user-set fields.
    const store = usePlaylistStore.getState();
    const liveTrack = store.tracksById[trackId];
    if (!liveTrack) return;

    const fillIns = displayFieldsFromMatch(match);
    if (Object.keys(fillIns).length > 0) {
      store.fillMissingDisplayFields(trackId, fillIns);
    }
    store.updateTrack(trackId, { spotify: match });
  } catch (error) {
    // Track was deleted (or the playlist was cleared) while the
    // search was queued. The row no longer exists, so there's
    // nothing to update and nothing to toast. updateTrack would be
    // a no-op anyway but skipping is clearer.
    if (error instanceof RequestCancelledError) return;
    console.error("Spotify match failed", { trackId, error });
    reportFirstError(error);
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
  const limiter = new ConcurrencyLimiter(SPOTIFY_SEARCH_CONCURRENCY);
  const allTrackIds = usePlaylistStore.getState().playlist.trackIds;
  const trackIds = scope
    ? allTrackIds.filter((id) => scope.has(id))
    : allTrackIds;
  await Promise.all(
    trackIds.map((id) => limiter.run(() => matchOne(id, reportFirstError))),
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
