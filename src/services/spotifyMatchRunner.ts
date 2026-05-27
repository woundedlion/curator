import { SPOTIFY_SEARCH_CONCURRENCY } from "../constants";
import {
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
  usePlaylistStore.getState().updateTrack(trackId, {
    spotify: { ...track.spotify, status: "pending" },
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
  if (!track || track.spotify.status === "matched") return;
  if (track.source.kind === "spotify-import") return;

  markPending(trackId);

  const market = useSpotifyStore.getState().user?.country;
  try {
    const match = await searchSpotifyForTrack(track, clientId, market);

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
    console.error("Spotify match failed", { trackId, error });
    reportFirstError(error);
    usePlaylistStore.getState().updateTrack(trackId, {
      spotify: { status: "missing" },
    });
  }
}

function displayFieldsFromMatch(match: SpotifyMatch) {
  if (match.status !== "matched" || !match.uri) return {};
  const chosen = match.candidates?.find((candidate) => candidate.uri === match.uri);
  if (!chosen) return {};
  return spotifyDisplayFieldsFromCandidate(chosen);
}

export async function matchAllOnSpotify(): Promise<void> {
  const reportFirstError = createErrorReporter();
  const limiter = new ConcurrencyLimiter(SPOTIFY_SEARCH_CONCURRENCY);
  const trackIds = usePlaylistStore.getState().playlist.trackIds;
  await Promise.all(
    trackIds.map((id) => limiter.run(() => matchOne(id, reportFirstError))),
  );
}

export async function rematchOnSpotify(trackId: string): Promise<void> {
  await matchOne(trackId, createErrorReporter());
}

// Promotes already-stored ambiguous Spotify matches that have exactly one
// candidate to "matched". Brings older playlists in line with the
// auto-select-single-candidate behavior without re-hitting the API.
export function promoteSingleCandidateMatches(): void {
  const store = usePlaylistStore.getState();
  for (const trackId of store.playlist.trackIds) {
    const track = store.tracksById[trackId];
    if (!track) continue;
    const { spotify } = track;
    if (spotify.status === "matched") continue;
    if (!spotify.candidates || spotify.candidates.length !== 1) continue;
    const only = spotify.candidates[0];
    store.updateTrack(trackId, {
      ...spotifyDisplayFieldsFromCandidate(only),
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
