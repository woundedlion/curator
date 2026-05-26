import { deleteCachedCandidates } from "../db/musicbrainzCache";
import { probeCoverArtUrl } from "../enrichment/coverArt";
import { enrichTrack } from "../enrichment/enrichmentService";
import { normalizeForMatching } from "../metadata/normalizers";
import { usePlaylistStore } from "../store/playlistStore";
import { useSettingsStore } from "../store/settingsStore";
import { useUiStore } from "../store/uiStore";
import type { Track } from "../types";

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

function fillMissing<T>(existing: T, fromMatch: T): T {
  return existing ?? fromMatch;
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

  try {
    const outcome = await enrichTrack(
      track,
      settings.musicbrainzContact,
      settings.acceptThresholds.mb,
      { bypassCache: options.bypassCache },
    );
    const best = outcome.candidates[0];
    // MB is now always supplementary: fill missing fields only. Spotify
    // (when matched) and the user (when edited) own the displayed values.
    const fillIns =
      outcome.status === "matched" && best
        ? {
            title: fillMissing(track.title, best.title),
            artist: fillMissing(track.artist, best.artist),
            album: fillMissing(track.album, best.album),
            year: fillMissing(track.year, best.year),
            originalYear: fillMissing(track.originalYear, best.originalYear),
          }
        : {};
    usePlaylistStore.getState().updateTrack(trackId, {
      ...fillIns,
      enrichment: {
        status: outcome.status,
        candidates: outcome.candidates,
        score: outcome.topScore,
        mbRecordingId: outcome.recordingId,
      },
    });
    if (outcome.status === "matched" && best?.releaseId && !track.coverUrl) {
      void probeCoverArtUrl(best.releaseId).then((url) => {
        if (url) {
          usePlaylistStore.getState().updateTrack(trackId, { coverUrl: url });
        }
      });
    }
    return { result: outcome.status, failureReason: outcome.failureReason };
  } catch (error) {
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

export async function enrichAllPending(): Promise<void> {
  const trackIds = usePlaylistStore.getState().playlist.trackIds.filter(
    (id) => !shouldSkipTrack(id),
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

function isSpotifyImport(trackId: string): boolean {
  const track = usePlaylistStore.getState().tracksById[trackId];
  return Boolean(track && track.source.kind === "spotify-import");
}

// `reenrichAll` (toolbar ↻) is explicit but bulk — treat it as "automatic
// enough" that user-picked rows are preserved. A user who picked a
// specific MB candidate via the ambiguous-enrichment dialog had their
// row set with `userOverride = true`; wiping that in a bulk pass would
// silently destroy their choice. The per-row ↻ deliberately clears
// `userOverride` and re-enriches a single row — that's the escape hatch.
function isUserOverridden(trackId: string): boolean {
  const track = usePlaylistStore.getState().tracksById[trackId];
  return Boolean(track && track.enrichment.userOverride);
}

async function resetTrackForReenrichment(trackId: string): Promise<void> {
  await clearTrackEnrichmentCache(trackId);
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
  const trackIds = usePlaylistStore
    .getState()
    .playlist.trackIds.filter(
      (id) => !isSpotifyImport(id) && !isUserOverridden(id),
    );
  if (trackIds.length === 0) return;

  await useUiStore.getState().withBusy(async () => {
    for (const trackId of trackIds) {
      await resetTrackForReenrichment(trackId);
    }
    const summary: BatchSummary = {
      attempted: 0,
      errorCount: 0,
      firstError: null,
      noResultCount: 0,
      noQueryCount: 0,
    };
    for (const trackId of trackIds) {
      const outcome = await runOneTrack(trackId, { bypassCache: true });
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
  });
}

export async function reenrichTrack(trackId: string): Promise<EnrichmentResult> {
  if (!hasContactEmail()) {
    warnMissingContactEmail();
    return "failed";
  }
  await clearTrackEnrichmentCache(trackId);
  clearTrackEnrichmentOverride(trackId);
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
