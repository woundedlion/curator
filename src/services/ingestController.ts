import { DEFAULT_PLAYLIST_NAME } from "../constants";
import type { CuratorExportEnvelope } from "../ingest/curatorExportFormat";
import {
  buildTracksFromExport,
  countResolved,
  tryParseCuratorExport,
} from "../ingest/curatorExportParser";
import { isTextFile } from "../ingest/fileExtension";
import { walkDirectoryHandle } from "../ingest/folderWalker";
import { ingestFiles } from "../ingest/ingestPipeline";
import { readBlobAsText } from "../util/textNormalize";
import { SpotifyForbiddenError } from "../spotify/apiClient";
import { fetchPlaylistTracks } from "../spotify/playlists";
import { usePlaylistStore } from "../store/playlistStore";
import { useSettingsStore } from "../store/settingsStore";
import { useUiStore } from "../store/uiStore";
import { enrichAllPending } from "./enrichmentRunner";
import { matchAllOnSpotify } from "./spotifyMatchRunner";

// Chains all post-ingest match-then-enrich runs onto a single promise.
// If a second ingest finishes while the first's runners are still going,
// its match+enrich step waits for the previous one to drain instead of
// running in parallel and racing on shared track state. The chain
// .catch's onto a resolved promise so one failure does not poison the
// queue for subsequent runs.
let backgroundRunners: Promise<void> = Promise.resolve();

async function runPostIngestSweep(): Promise<void> {
  // Streaming match+enrich: the Spotify search runner and the MB
  // enrichment runner run concurrently. The MB runner stays alive
  // while Spotify is still working, polling for tracks the search
  // promotes to `spotify.matched` and enriching them as they land.
  //
  // Why this matters: a pure-audio-file drop arrives with every
  // row at `spotify.idle`. Without streaming, the first MB pass
  // would find no eligible tracks (MB requires `spotify.matched`
  // when Spotify is configured) and exit immediately; the second
  // pass would have to wait for ALL Spotify searches to finish
  // before starting any MB lookup. With streaming, MB starts
  // enriching the first row the moment Spotify promotes it.
  let spotifyDone = false;
  const spotifyTask = matchAllOnSpotify().finally(() => {
    spotifyDone = true;
  });
  const mbTask = enrichAllPending(undefined, {
    whileActive: () => !spotifyDone,
  });
  await Promise.all([spotifyTask, mbTask]);
}

// Queue this drop's post-ingest match+enrich onto the serialized chain
// and hand back a promise that settles when THIS drop's sweep finishes.
// Callers await it INSIDE their busy bracket so the global spinner stays
// lit continuously from the start of the drop through the end of the
// sweep (the sweep is part of the same user action). The returned promise
// only reflects this drop's sweep, not the prior chain entries it waits
// behind, so one drop's spinner doesn't get pinned by an unrelated drop's
// runners. The sweep itself is NOT wrapped in withBusy here — the busy
// state is owned by the foreground caller's bracket; double-bracketing
// would just inflate the ref-count without changing observable behavior.
function queuePostIngestRunners(): Promise<void> {
  const sweep = backgroundRunners.then(runPostIngestSweep);
  // Pin a resolved promise as the new chain head so a rejection here
  // doesn't poison the next ingest. The runners themselves push toasts
  // for user-visible failures; this log is the only trace of an
  // *unexpected* crash that escaped them.
  backgroundRunners = sweep.catch((error) => {
    console.error("post-ingest runners crashed unexpectedly", error);
  });
  // Surface a settled promise to the caller too: swallow the error (it is
  // already logged above) so awaiting the sweep to keep the spinner lit
  // never turns a background failure into a foreground rejection.
  return sweep.catch(() => undefined);
}

async function addAndEnrich(files: File[]): Promise<void> {
  if (files.length === 0) return;
  const ui = useUiStore.getState();
  // One continuous busy bracket for the whole user action: parse/add the
  // files AND await the post-ingest sweep they trigger. Previously the
  // ingest had its own withBusy that closed before the sweep was queued,
  // so the spinner flickered off in the gap between "tracks added" and
  // "match+enrich started". Awaiting the sweep inside the same bracket
  // keeps it lit until the drop fully settles.
  await ui.withBusy(async () => {
    const { tracks, failures } = await ingestFiles(files);
    if (tracks.length === 0 && failures.length === 0) {
      ui.pushToast({ kind: "info", message: "No ingestible files in drop" });
    } else {
      if (tracks.length > 0) {
        usePlaylistStore.getState().addTracks(tracks);
        ui.pushToast({
          kind: "success",
          message: `Added ${tracks.length} tracks`,
        });
      }
      if (failures.length > 0) {
        ui.pushToast({
          kind: "error",
          message: `Skipped ${failures.length} file${failures.length === 1 ? "" : "s"} that failed to parse — see console`,
        });
      }
    }
    // Queue the sweep unconditionally (matching the prior behavior where
    // it ran even after the "no ingestible files" path) and await it so
    // the busy bracket spans the whole drop. The runners no-op when there
    // is nothing eligible, so an empty drop just settles immediately.
    await queuePostIngestRunners();
  });
}

// Read text files once up front so we can route Curator-export drops to
// the rich importer (metadata restoration + per-file toast) and leave
// everything else to the existing ingest pipeline. Files that read fail
// fall through as "others" — the downstream parser will surface its own
// error rather than us swallowing it here.
type Classification =
  | { kind: "envelope"; env: CuratorExportEnvelope }
  | { kind: "other"; file: File };

async function classifyOne(file: File): Promise<Classification> {
  if (!isTextFile(file.name)) return { kind: "other", file };
  try {
    // Read via the shared UTF-8-then-Windows-1252 fallback decoder used
    // by the real text-ingest path (parseTextFile). The browser's
    // `File.text()` is hard-coded to UTF-8 and replaces invalid bytes
    // with U+FFFD, so a curator export saved as "ANSI" would have its
    // accented characters mangled before tryParseCuratorExport ever saw
    // them. Routing both detection and ingest through the same decoder
    // keeps encoding handling consistent.
    const env = tryParseCuratorExport(await readBlobAsText(file));
    return env ? { kind: "envelope", env } : { kind: "other", file };
  } catch {
    return { kind: "other", file };
  }
}

async function partitionCuratorExports(
  files: File[],
): Promise<{ envelopes: CuratorExportEnvelope[]; others: File[] }> {
  // Read all text files in parallel. `Promise.all` preserves input order
  // in the resolved array, so the trailing partition pass naturally
  // keeps `others` in dropped sequence — no index bookkeeping needed.
  const classifications = await Promise.all(files.map(classifyOne));
  const envelopes: CuratorExportEnvelope[] = [];
  const others: File[] = [];
  for (const c of classifications) {
    if (c.kind === "envelope") envelopes.push(c.env);
    else others.push(c.file);
  }
  return { envelopes, others };
}

// Busy is NOT bracketed here — the caller (ingestDroppedFiles) holds a
// single continuous busy bracket around the whole dropped batch so the
// spinner doesn't flicker off between envelopes. This is a plain,
// synchronous-ish store mutation; there is no awaited I/O to bracket
// anyway (the envelope text was already read during partitioning).
function importEnvelope(env: CuratorExportEnvelope): void {
  const ui = useUiStore.getState();
  const store = usePlaylistStore.getState();
  // Restore playlist metadata only when the draft is still untouched —
  // dropping an export onto a working playlist should never silently
  // rename it. (Documented in §4.5.1 of DESIGN.md.)
  const draftIsPristine =
    store.playlist.trackIds.length === 0 &&
    store.playlist.name === DEFAULT_PLAYLIST_NAME;
  if (draftIsPristine && env.name) {
    store.setPlaylistMeta({
      name: env.name,
      description: env.description ?? "",
      public: env.public ?? false,
      collaborative: env.collaborative ?? false,
    });
  }
  const tracks = buildTracksFromExport(env);
  store.addTracks(tracks);
  const stats = countResolved(env);
  ui.pushToast({
    kind: "success",
    message: `Imported ${stats.total} tracks (${stats.spotifyMatched} Spotify-matched, ${stats.mbMatched} MB-enriched)`,
  });
  // NOTE: queueing the post-ingest runner sweep is the CALLER's job.
  // Dropping N export files would otherwise queue N redundant full
  // match+enrich sweeps; ingestDroppedFiles queues a single sweep after
  // the whole batch is imported instead. Resolved rows (matched status)
  // are skipped by both runners, so the one sweep only touches whatever
  // unresolved tracks the batch contributed.
}

export async function ingestDroppedFiles(files: File[]): Promise<void> {
  // The other public entry points (importPlaylistById, pickFolderAndIngest)
  // each surface a toast on failure; this one parses/builds tracks from a
  // dropped batch and could throw outside any runner's own error handling
  // (e.g. buildTracksFromExport on a malformed envelope, or addTracks).
  // Without this catch the rejection escapes to the fire-and-forget caller
  // in App.tsx as a silent console-only unhandled rejection. (The busy
  // counter stays balanced regardless — withBusy brackets its work with a
  // finally.)
  try {
    // A single continuous busy bracket for the whole drop. Previously each
    // importEnvelope and the trailing sweep bracketed their own busy, so
    // the spinner flickered off between envelopes and again before the
    // post-ingest sweep. Holding ONE bracket across partition → all
    // envelope imports → the sweep keeps it lit until the whole drop
    // settles. addAndEnrich nests its own bracket; ref-counting means the
    // counter just rises to 2 and back to 1 there — it never returns to 0
    // mid-drop, so there's no flicker and no unbalanced counter.
    await useUiStore.getState().withBusy(async () => {
      const { envelopes, others } = await partitionCuratorExports(files);
      for (const env of envelopes) importEnvelope(env);
      // Audio/text "others" run through addAndEnrich, which queues and
      // awaits its own sweep. Only queue an extra sweep for the envelope
      // batch when there are no others to piggy-back on — otherwise the
      // addAndEnrich sweep (serialized after these imports complete)
      // already covers the unresolved rows the envelopes contributed, and
      // a second queued sweep would be redundant. Either way we AWAIT so
      // the busy bracket spans the sweep, not just the synchronous import.
      if (others.length > 0) {
        await addAndEnrich(others);
      } else if (envelopes.length > 0) {
        await queuePostIngestRunners();
      }
    });
  } catch (error) {
    console.error("ingestDroppedFiles failed", error);
    const detail =
      error instanceof Error ? error.message : "see console for details";
    useUiStore.getState().pushToast({
      kind: "error",
      message: `Couldn't add dropped files: ${detail}`,
    });
  }
}

export async function importPlaylistById(playlistId: string): Promise<void> {
  const clientId = useSettingsStore.getState().settings.spotifyClientId;
  const ui = useUiStore.getState();
  if (!clientId) {
    ui.pushToast({
      kind: "error",
      message: "Connect to Spotify in Settings before importing playlists",
    });
    return;
  }
  try {
    // One continuous busy bracket: fetch + add the tracks AND await the
    // post-ingest sweep. Awaiting the sweep inside the bracket keeps the
    // spinner lit until the whole import settles instead of dropping it
    // the instant the tracks land.
    await ui.withBusy(async () => {
      const tracks = await fetchPlaylistTracks(playlistId, clientId);
      if (tracks.length === 0) {
        ui.pushToast({ kind: "info", message: "Playlist has no tracks" });
      } else {
        usePlaylistStore.getState().addTracks(tracks);
        ui.pushToast({
          kind: "success",
          message: `Appended ${tracks.length} tracks from Spotify`,
        });
      }
      await queuePostIngestRunners();
    });
  } catch (error) {
    console.error("importPlaylistById failed", error);
    if (error instanceof SpotifyForbiddenError) {
      ui.pushToast({
        kind: "error",
        message: `Spotify returned 403 — ${error.message}. Check console for the full response.`,
      });
      return;
    }
    const detail =
      error instanceof Error ? error.message : "see console for details";
    ui.pushToast({
      kind: "error",
      message: `Couldn't import playlist: ${detail}`,
    });
  }
}

declare global {
  interface Window {
    showDirectoryPicker?: () => Promise<FileSystemDirectoryHandle>;
  }
}

export async function pickFolderAndIngest(): Promise<void> {
  const recursive = useSettingsStore.getState().settings.recursiveFolderScan;
  if (typeof window.showDirectoryPicker === "function") {
    try {
      const handle = await window.showDirectoryPicker();
      const files = await walkDirectoryHandle(handle, { recursive });
      await addAndEnrich(files);
    } catch (error) {
      // User-cancelled the OS picker is the only silent path. Any
      // other error (filesystem failure, permission revoked mid-walk,
      // corrupt directory) needs to surface — silently swallowing
      // makes the button look broken.
      if (error instanceof DOMException && error.name === "AbortError") return;
      console.error("pickFolderAndIngest failed", error);
      useUiStore.getState().pushToast({
        kind: "error",
        message:
          error instanceof Error
            ? `Folder scan failed: ${error.message}`
            : "Folder scan failed — see console",
      });
    }
    return;
  }
  fallbackFolderInput(recursive);
}

function fallbackFolderInput(recursive: boolean): void {
  const input = document.createElement("input");
  input.type = "file";
  input.setAttribute("webkitdirectory", "");
  input.multiple = true;
  input.addEventListener("change", async () => {
    if (!input.files) return;
    let files = Array.from(input.files);
    // `<input webkitdirectory>` always reports the full recursive tree —
    // there is no non-recursive mode on the input. When the user has
    // disabled recursion, keep only the direct children of the picked
    // folder (entries whose webkitRelativePath has exactly two segments:
    // the root folder name and the filename).
    if (!recursive) {
      files = files.filter((file) => {
        const path = (file as File & { webkitRelativePath?: string })
          .webkitRelativePath;
        if (!path) return true;
        return path.split("/").length <= 2;
      });
    }
    await addAndEnrich(files);
  });
  input.click();
}
