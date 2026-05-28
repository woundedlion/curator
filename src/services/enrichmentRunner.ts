import { deleteCachedCandidates } from "../db/musicbrainzCache";
import { probeCoverArtUrl } from "../enrichment/coverArt";
import { enrichTrack } from "../enrichment/enrichmentService";
import { normalizeForMatching } from "../metadata/normalizers";
import { RequestCancelledError } from "../util/intervalQueue";
import { usePlaylistStore } from "../store/playlistStore";
import { useSettingsStore } from "../store/settingsStore";
import { useUiStore } from "../store/uiStore";
import type { Track } from "../types";
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
};

function shouldSkipTrack(trackId: string): boolean {
  const state = usePlaylistStore.getState();
  const track = state.tracksById[trackId];
  if (!track) return true;
  if (track.enrichment.userOverride) return true;
  if (track.enrichment.status === "matched") return true;
  // Spotify is source of truth: when configured, only enrich tracks Spotify
  // confirmed. Ambiguous tracks enrich after the user picks (via reenrichTrack
  // in spotifyPicker); missing tracks stay un-enriched.
  const spotifyConfigured = Boolean(
    useSettingsStore.getState().settings.spotifyClientId,
  );
  if (spotifyConfigured && track.spotify.status !== "matched") return true;
  return false;
}


function markPending(trackId: string): void {
  const existing = usePlaylistStore.getState().tracksById[trackId];
  if (!existing) return;
  usePlaylistStore.getState().updateTrack(trackId, {
    enrichment: { ...existing.enrichment, status: "pending" },
  });
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
    if (!liveTrack) return { result: outcome.status, failureReason: outcome.failureReason };

    // Preserve `userOverride` across re-enrichment — it survives a bulk
    // pass via shouldSkipTrack/isUserOverridden, but if the user picked a
    // candidate via the ambiguous-MB dialog and then a re-enrichment
    // landed, we need to keep the bit set.
    if (outcome.status === "matched" && best) {
      store.fillMissingDisplayFields(trackId, {
        title: best.title,
        artist: best.artist,
        album: best.album,
        year: best.year,
        originalYear: best.originalYear,
      });
    }
    store.updateTrack(trackId, {
      enrichment: {
        status: outcome.status,
        candidates: outcome.candidates,
        score: outcome.topScore,
        mbRecordingId: outcome.recordingId,
        userOverride: liveTrack.enrichment.userOverride,
      },
    });
    if (outcome.status === "matched" && best?.releaseId) {
      void probeCoverArtUrl(best.releaseId).then((url) => {
        if (!url) return;
        // Re-check: the track may have been removed, or its identity may
        // have changed (different mbRecordingId picked, or a Spotify
        // candidate selected) during the cover-art HEAD probe.
        const current = usePlaylistStore.getState().tracksById[trackId];
        if (!current) return;
        if (current.enrichment.mbRecordingId !== outcome.recordingId) return;
        usePlaylistStore
          .getState()
          .fillMissingDisplayFields(trackId, { coverUrl: url });
      });
    }
    return { result: outcome.status, failureReason: outcome.failureReason };
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
};

function pushErrorToast(message: string): void {
  useUiStore.getState().pushToast({ kind: "error", message });
}

function describeFirstError(firstError: unknown): string {
  if (firstError instanceof Error) return firstError.message;
  return "unknown error";
}

function reportBatchOutcome(summary: BatchSummary): void {
  if (summary.attempted === 0) return;
  if (summary.errorCount > 0) {
    pushErrorToast(
      `MusicBrainz lookups failed (${summary.errorCount}): ${describeFirstError(summary.firstError)}`,
    );
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
  }
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

export async function enrichAllPending(
  scope?: ReadonlySet<string>,
): Promise<void> {
  const trackIds = usePlaylistStore
    .getState()
    .playlist.trackIds.filter(
      (id) => !shouldSkipTrack(id) && (!scope || scope.has(id)),
    );
  if (trackIds.length === 0) return;

  if (!hasContactEmail()) {
    warnMissingContactEmail();
    return;
  }

  const summary: BatchSummary = {
    attempted: 0,
    errorCount: 0,
    firstError: null,
    noResultCount: 0,
    noQueryCount: 0,
  };
  for (const trackId of trackIds) {
    const outcome = await runOneTrack(trackId);
    summary.attempted++;
    if (outcome.error !== undefined) {
      summary.errorCount++;
      if (summary.firstError === null) summary.firstError = outcome.error;
    } else if (outcome.result === "failed") {
      if (outcome.failureReason === "no-query") summary.noQueryCount++;
      else summary.noResultCount++;
    }
  }
  reportBatchOutcome(summary);
}

function cacheKeyFor(track: Track) {
  return {
    title: normalizeForMatching(track.title),
    artist: normalizeForMatching(track.artist),
    album: normalizeForMatching(track.album),
  };
}

async function clearTrackEnrichmentCache(trackId: string): Promise<void> {
  const track = usePlaylistStore.getState().tracksById[trackId];
  if (!track) return;
  try {
    await deleteCachedCandidates(cacheKeyFor(track));
  } catch (error) {
    console.warn("clearTrackEnrichmentCache failed", { trackId, error });
  }
}

function clearTrackEnrichmentOverride(trackId: string): void {
  const track = usePlaylistStore.getState().tracksById[trackId];
  if (!track) return;
  usePlaylistStore.getState().updateTrack(trackId, {
    enrichment: { status: "idle" },
  });
}

// Toolbar "re-enrich all" (↻) is a "resume unfinished work" button —
// it picks up tracks whose Spotify lookup or MB lookup hasn't happened
// yet, and leaves rows that have already been resolved (matched /
// ambiguous / missing on Spotify; matched / ambiguous / failed on MB)
// untouched. The per-row ↻ remains the escape hatch for "redo from
// scratch" on a single row, since it explicitly clears state and
// re-runs every step.
function isTrackPendingLookup(track: Track, spotifyConfigured: boolean): boolean {
  if (track.enrichment.userOverride) return false;
  if (track.source.kind === "spotify-import") {
    return track.enrichment.status === "idle";
  }
  if (!spotifyConfigured) {
    return track.enrichment.status === "idle";
  }
  // With Spotify configured: only truly-unknown rows are eligible.
  //   - Spotify idle  : needs a Spotify search (and MB will run after).
  //   - Spotify matched + MB idle : MB never ran for this resolved row.
  // Every other state is a resolved decision the user already saw
  // (ambiguous = waiting on user picker; missing = Spotify said no;
  // matched on both = done). Re-queueing those on every toolbar ↻
  // burns the rate-limit budget on settled work.
  if (track.spotify.status === "idle") return true;
  if (
    track.spotify.status === "matched" &&
    track.enrichment.status === "idle"
  ) {
    return true;
  }
  return false;
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
    return Boolean(track) && isTrackPendingLookup(track, spotifyConfigured);
  });
  if (pendingTrackIds.length === 0) return;

  const scope = new Set(pendingTrackIds);
  await useUiStore.getState().withBusy(async () => {
    // Run match + enrich in parallel for the pending subset; second
    // enrich pass picks up rows the Spotify search promoted to
    // "matched". No state reset — the rows are already in `idle`, which
    // is what the runners want to see.
    await Promise.all([matchAllOnSpotify(scope), enrichAllPending(scope)]);
    await enrichAllPending(scope);
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
  }
  return outcome.result;
}

export async function reenrichTrack(trackId: string): Promise<EnrichmentResult> {
  if (!hasContactEmail()) {
    warnMissingContactEmail();
    return "failed";
  }
  await clearTrackEnrichmentCache(trackId);
  clearTrackEnrichmentOverride(trackId);
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
  }
  return outcome.result;
}
