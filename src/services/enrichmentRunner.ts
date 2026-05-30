import {
  cacheKeyForTrack,
  deleteCachedCandidates,
} from "../db/musicbrainzCache";
import { probeCoverArtUrl } from "../enrichment/coverArt";
import {
  enrichTrack,
  type EnrichmentOutcome,
} from "../enrichment/enrichmentService";
import { RequestCancelledError } from "../util/intervalQueue";
import { usePlaylistStore } from "../store/playlistStore";
import { useSettingsStore } from "../store/settingsStore";
import { useUiStore } from "../store/uiStore";
import type { Enrichment } from "../types";
import {
  isTrackPendingLookup,
  shouldEnrichTrack,
} from "./enrichmentEligibility";
import {
  matchAllOnSpotify,
  rematchOnSpotify,
  resetSpotifyStatusForRefresh,
} from "./spotifyMatchRunner";

type EnrichmentResult = "matched" | "ambiguous" | "failed";

type RunOutcome = {
  result: EnrichmentResult;
  error?: unknown;
  failureReason?: "no-query" | "no-results";
  coverArtTransientFailure?: boolean;
};

function shouldSkipTrack(trackId: string): boolean {
  const track = usePlaylistStore.getState().tracksById[trackId];
  const spotifyConfigured = Boolean(
    useSettingsStore.getState().settings.spotifyClientId,
  );
  return !shouldEnrichTrack(track, spotifyConfigured);
}


function markPending(trackId: string): void {
  const existing = usePlaylistStore.getState().tracksById[trackId];
  if (!existing) return;
  usePlaylistStore.getState().updateTrack(trackId, {
    enrichment: {
      status: "pending",
      userOverride: existing.enrichment.userOverride,
    },
  });
}

// Translates an `EnrichmentOutcome` into the corresponding `Enrichment`
// arm. `userOverride` is preserved from the live track because a bulk
// re-enrich after a user picked a candidate via the ambiguous-MB
// dialog must keep that bit set — shouldSkipTrack/isTrackPendingLookup
// honor it elsewhere, but this layer is responsible for not dropping it
// on the write back.
function buildEnrichmentFromOutcome(
  outcome: EnrichmentOutcome,
  userOverride: boolean | undefined,
): Enrichment {
  if (outcome.status === "matched" && outcome.recordingId) {
    return {
      status: "matched",
      mbRecordingId: outcome.recordingId,
      score: outcome.topScore,
      candidates: outcome.candidates,
      userOverride,
    };
  }
  if (outcome.status === "ambiguous") {
    return {
      status: "ambiguous",
      candidates: outcome.candidates,
      score: outcome.topScore,
      userOverride,
    };
  }
  return {
    status: "failed",
    candidates:
      outcome.candidates.length > 0 ? outcome.candidates : undefined,
    userOverride,
  };
}

// Awaited inline by the caller so a transient probe failure can be
// aggregated into the batch toast. Cost is bounded: probes run through
// a 4-wide limiter and the MB queue (1 req/sec) is the actual
// bottleneck — probes typically resolve well inside one MB pacer
// interval. Returns whether the failure was a *transient* miss
// (network/5xx) — confirmed 404s are absorbed by the negative cache
// and reported as a non-failure here.
async function applyCoverArtIfAvailable(
  trackId: string,
  recordingId: string | undefined,
  releaseId: string | undefined,
): Promise<boolean> {
  if (!releaseId) return false;
  const probe = await probeCoverArtUrl(releaseId);
  if (probe.kind === "transient") return true;
  if (probe.kind !== "ok") return false;
  // Re-check: the track may have been removed, or its identity may have
  // changed (different mbRecordingId picked, or a Spotify candidate
  // selected) during the cover-art HEAD probe.
  const current = usePlaylistStore.getState().tracksById[trackId];
  const currentRecordingId =
    current?.enrichment.status === "matched"
      ? current.enrichment.mbRecordingId
      : undefined;
  if (current && currentRecordingId === recordingId) {
    usePlaylistStore
      .getState()
      .fillMissingDisplayFields(trackId, { coverUrl: probe.url });
  }
  return false;
}

async function runOneTrack(
  trackId: string,
  options: { bypassCache?: boolean } = {},
): Promise<RunOutcome> {
  const settings = useSettingsStore.getState().settings;
  if (!settings.musicbrainzContact) return { result: "failed" };

  const track = usePlaylistStore.getState().tracksById[trackId];
  if (!track) return { result: "failed" };

  markPending(trackId);

  // Defense-in-depth: re-checked when each queued MB request pops.
  // The primary cancellation path is `cancelMusicbrainzRequestsByTag`
  // wired into the playlist store's deletion actions; this guard
  // catches the gap where the task already shifted out of pending
  // before the cancel fired, or a deletion path that forgot to call
  // the cancel hook entirely.
  const stillAlive = () =>
    Boolean(usePlaylistStore.getState().tracksById[trackId]);

  try {
    const outcome = await enrichTrack(
      track,
      settings.musicbrainzContact,
      settings.acceptThresholds.mb,
      { bypassCache: options.bypassCache, guard: stillAlive },
    );
    const best = outcome.candidates[0];

    // Re-read the live track inside the store so the store-level merge
    // honors any concurrent user/Spotify edits that landed during the
    // (multi-second) async search. The store action does the only-fill-
    // missing merge atomically inside set(), so this closure's stale
    // `track` snapshot can no longer clobber a fresher value.
    const store = usePlaylistStore.getState();
    const liveTrack = store.tracksById[trackId];
    if (!liveTrack) {
      return { result: outcome.status, failureReason: outcome.failureReason };
    }

    // Drop late results that arrive after a reset. The runner sets
    // `enrichment.status = "pending"` at start via markPending; if the
    // live status is anything else by the time we resume, something
    // else has touched the row — most commonly nukeEnrichmentState
    // (which cancels QUEUED tasks but cannot abort IN-FLIGHT HTTP
    // calls; the network response can still land here after the row
    // was reset to idle). Without this guard, the late response would
    // silently rewrite a nuked row back to matched/ambiguous/failed.
    if (liveTrack.enrichment.status !== "pending") {
      return { result: outcome.status, failureReason: outcome.failureReason };
    }

    if (outcome.status === "matched" && best) {
      store.fillMissingDisplayFields(trackId, {
        title: best.title,
        artist: best.artist,
        album: best.album,
        year: best.year,
        originalYear: best.originalYear,
      });
    }
    const enrichment = buildEnrichmentFromOutcome(
      outcome,
      liveTrack.enrichment.userOverride,
    );
    store.updateTrack(trackId, { enrichment });

    const coverArtTransientFailure =
      outcome.status === "matched"
        ? await applyCoverArtIfAvailable(
            trackId,
            outcome.recordingId,
            best?.releaseId,
          )
        : false;

    return {
      result: outcome.status,
      failureReason: outcome.failureReason,
      coverArtTransientFailure,
    };
  } catch (error) {
    // Track was deleted while the lookup was queued. The row no
    // longer exists; updateTrack would be a no-op anyway, but the
    // early return keeps the error reporting path silent.
    if (error instanceof RequestCancelledError) {
      return { result: "failed" };
    }
    console.error("MusicBrainz enrichment failed", { trackId, error });
    usePlaylistStore.getState().updateTrack(trackId, {
      enrichment: { status: "failed" },
    });
    return { result: "failed", error };
  }
}

type BatchSummary = {
  attempted: number;
  errorCount: number;
  firstError: unknown;
  noResultCount: number;
  noQueryCount: number;
  coverArtTransientFailures: number;
};

function pushErrorToast(message: string): void {
  useUiStore.getState().pushToast({ kind: "error", message });
}

function pushInfoToast(message: string): void {
  useUiStore.getState().pushToast({ kind: "info", message });
}

function describeFirstError(firstError: unknown): string {
  if (firstError instanceof Error) return firstError.message;
  return "unknown error";
}

function maybeReportCoverArtFailures(count: number): void {
  if (count <= 0) return;
  const noun = count === 1 ? "track" : "tracks";
  pushInfoToast(
    `Cover art unavailable for ${count} ${noun} (transient network failure — re-enrich to retry)`,
  );
}

function reportBatchOutcome(summary: BatchSummary): void {
  if (summary.attempted === 0) return;
  if (summary.errorCount > 0) {
    pushErrorToast(
      `MusicBrainz lookups failed (${summary.errorCount}): ${describeFirstError(summary.firstError)}`,
    );
    maybeReportCoverArtFailures(summary.coverArtTransientFailures);
    return;
  }
  if (summary.noQueryCount === summary.attempted) {
    pushErrorToast(
      "Couldn't build MusicBrainz queries — tracks have no title/artist metadata or filename hints",
    );
    return;
  }
  if (summary.noResultCount + summary.noQueryCount === summary.attempted) {
    const noQueryNote =
      summary.noQueryCount > 0
        ? ` (${summary.noQueryCount} had no metadata to query)`
        : "";
    pushErrorToast(
      `No MusicBrainz matches for any track${noQueryNote} — check the MB-debug URL in the console`,
    );
    return;
  }
  maybeReportCoverArtFailures(summary.coverArtTransientFailures);
}

function hasContactEmail(): boolean {
  return Boolean(
    useSettingsStore.getState().settings.musicbrainzContact.trim(),
  );
}

function warnMissingContactEmail(): void {
  pushErrorToast(
    "Add a MusicBrainz contact email in Settings to enable enrichment",
  );
}

// How often to recheck the playlist for newly-eligible tracks when the
// streaming loop has drained its current eligible set but a producer
// (e.g. the Spotify search runner) is still active. MB itself is
// gated by the 1-req/sec pacer so this poll only affects how quickly
// we *notice* new eligible tracks; we deliberately stay well under
// the pacer so a freshly-matched track waits at most ~50 ms before
// joining the MB queue.
const STREAMING_POLL_MS = 50;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type EnrichAllOptions = {
  /**
   * Streaming mode. When provided, `enrichAllPending` does not stop
   * after draining the eligible set at function entry — it polls the
   * playlist store while the predicate returns true and picks up any
   * track that becomes eligible (e.g. promoted to `spotify.matched`
   * by a concurrent Spotify search runner). Without this, MB
   * enrichment of late-matched tracks waits for the next post-ingest
   * pass, which on a pure-audio drop means waiting for the entire
   * Spotify search to finish first.
   */
  whileActive?: () => boolean;
};

export async function enrichAllPending(
  scope?: ReadonlySet<string>,
  options: EnrichAllOptions = {},
): Promise<void> {
  if (!hasContactEmail()) {
    // Only warn when there's actually work to do at function entry —
    // otherwise an empty playlist would needlessly toast.
    const anyEligible = usePlaylistStore
      .getState()
      .playlist.trackIds.some(
        (id) => !shouldSkipTrack(id) && (!scope || scope.has(id)),
      );
    if (anyEligible) warnMissingContactEmail();
    return;
  }

  const summary: BatchSummary = {
    attempted: 0,
    errorCount: 0,
    firstError: null,
    noResultCount: 0,
    noQueryCount: 0,
    coverArtTransientFailures: 0,
  };
  // Track which ids we've already started — prevents re-running MB on
  // a track that finished while the loop was elsewhere, and bounds the
  // streaming poll to at most one MB call per track per session.
  const seen = new Set<string>();

  while (true) {
    const trackIds = usePlaylistStore
      .getState()
      .playlist.trackIds.filter(
        (id) =>
          !seen.has(id) &&
          !shouldSkipTrack(id) &&
          (!scope || scope.has(id)),
      );
    if (trackIds.length === 0) {
      // Nothing eligible right now. Exit unless a producer is still
      // running, in which case poll briefly to catch its output.
      if (!options.whileActive || !options.whileActive()) break;
      await sleep(STREAMING_POLL_MS);
      continue;
    }
    for (const trackId of trackIds) {
      seen.add(trackId);
      const outcome = await runOneTrack(trackId);
      summary.attempted++;
      if (outcome.error !== undefined) {
        summary.errorCount++;
        if (summary.firstError === null) summary.firstError = outcome.error;
      } else if (outcome.result === "failed") {
        if (outcome.failureReason === "no-query") summary.noQueryCount++;
        else summary.noResultCount++;
      }
      if (outcome.coverArtTransientFailure) summary.coverArtTransientFailures++;
    }
  }
  reportBatchOutcome(summary);
}

async function clearTrackEnrichmentCache(trackId: string): Promise<void> {
  const track = usePlaylistStore.getState().tracksById[trackId];
  if (!track) return;
  try {
    await deleteCachedCandidates(cacheKeyForTrack(track));
  } catch (error) {
    console.warn("clearTrackEnrichmentCache failed", { trackId, error });
  }
}

function resetTrackEnrichmentToIdle(trackId: string): void {
  const track = usePlaylistStore.getState().tracksById[trackId];
  if (!track) return;
  usePlaylistStore.getState().updateTrack(trackId, {
    enrichment: { status: "idle" },
  });
}

export async function reenrichAll(): Promise<void> {
  if (!hasContactEmail()) {
    warnMissingContactEmail();
    return;
  }
  const state = usePlaylistStore.getState();
  const spotifyConfigured = Boolean(
    useSettingsStore.getState().settings.spotifyClientId,
  );
  const pendingTrackIds = state.playlist.trackIds.filter((id) => {
    const track = state.tracksById[id];
    return track !== undefined && isTrackPendingLookup(track, spotifyConfigured);
  });
  if (pendingTrackIds.length === 0) return;

  const scope = new Set(pendingTrackIds);
  await useUiStore.getState().withBusy(async () => {
    // Streaming mode: the MB runner stays alive while the Spotify
    // search is in flight, polling for newly-`matched` tracks and
    // enriching them as they land. No second pass needed — the loop
    // exits once both producers are quiet AND the eligible set is
    // empty.
    let spotifyDone = false;
    const spotifyTask = matchAllOnSpotify(scope).finally(() => {
      spotifyDone = true;
    });
    const mbTask = enrichAllPending(scope, {
      whileActive: () => !spotifyDone,
    });
    await Promise.all([spotifyTask, mbTask]);
  });
}

// MB-only enrichment for a single track. Used after the user picks a
// Spotify candidate via the disambiguation picker — the row's Spotify
// identity is exactly what the user just chose, so we must NOT re-run
// the Spotify search (it would clobber the user's pick with whatever
// auto-pick decides this time, which is almost always "still ambiguous"
// since that's why the picker was open in the first place). We only
// need to fill any displayed fields Spotify didn't supply.
export async function enrichOneTrackMb(
  trackId: string,
  options: { bypassCache?: boolean } = {},
): Promise<EnrichmentResult> {
  if (!hasContactEmail()) {
    warnMissingContactEmail();
    return "failed";
  }
  const outcome = await runOneTrack(trackId, options);
  if (outcome.error !== undefined) {
    pushErrorToast(
      `MusicBrainz lookup failed: ${describeFirstError(outcome.error)}`,
    );
  } else if (outcome.coverArtTransientFailure) {
    maybeReportCoverArtFailures(1);
  }
  return outcome.result;
}

export async function reenrichTrack(trackId: string): Promise<EnrichmentResult> {
  if (!hasContactEmail()) {
    warnMissingContactEmail();
    return "failed";
  }
  await clearTrackEnrichmentCache(trackId);
  resetTrackEnrichmentToIdle(trackId);
  // Re-run Spotify search first (skipped for spotify-imports by matchOne
  // itself, but we also leave their status alone via the reset helper so
  // the URI from import is preserved). MB enrichment then runs against
  // whatever identity the Spotify match settles on.
  resetSpotifyStatusForRefresh(trackId);
  await rematchOnSpotify(trackId);
  const outcome = await runOneTrack(trackId, { bypassCache: true });
  if (outcome.error !== undefined) {
    pushErrorToast(
      `MusicBrainz lookup failed: ${describeFirstError(outcome.error)}`,
    );
  } else if (outcome.result === "failed") {
    pushErrorToast("No MusicBrainz match for this track");
  } else if (outcome.coverArtTransientFailure) {
    maybeReportCoverArtFailures(1);
  }
  return outcome.result;
}
