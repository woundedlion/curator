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

function queuePostIngestRunners(): void {
  backgroundRunners = backgroundRunners.then(() =>
    useUiStore.getState().withBusy(async () => {
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
    }),
  );
  // Pin a resolved promise as the new chain head so a rejection here
  // doesn't poison the next ingest. The runners themselves push toasts
  // for user-visible failures; this log is the only trace of an
  // *unexpected* crash that escaped them.
  backgroundRunners = backgroundRunners.catch((error) => {
    console.error("post-ingest runners crashed unexpectedly", error);
  });
}

async function addAndEnrich(files: File[]): Promise<void> {
  if (files.length === 0) return;
  const ui = useUiStore.getState();
  await ui.withBusy(async () => {
    const { tracks, failures } = await ingestFiles(files);
    if (tracks.length === 0 && failures.length === 0) {
      ui.pushToast({ kind: "info", message: "No ingestible files in drop" });
      return;
    }
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
  });

  queuePostIngestRunners();
}

// Read text files once up front so we can route Curator-export drops to
// the rich importer (metadata restoration + per-file toast) and leave
// everything else to the existing ingest pipeline. Files that read fail
// fall through as "others" — the downstream parser will surface its own
// error rather than us swallowing it here.
async function partitionCuratorExports(
  files: File[],
): Promise<{ envelopes: CuratorExportEnvelope[]; others: File[] }> {
  // Read all text files in parallel — file.text() is independent per
  // file and was previously serialized in a for-loop, dominating the
  // routing time on drops with many .txt entries. The result-merge
  // preserves the input order of `others` so downstream parsing sees
  // files in their dropped sequence.
  const envelopes: CuratorExportEnvelope[] = [];
  const others: File[] = new Array(files.length);
  const textReads: Promise<{ index: number; env: CuratorExportEnvelope | null }>[] = [];
  for (let i = 0; i < files.length; i++) {
    const file = files[i]!;
    if (!isTextFile(file.name)) {
      others[i] = file;
      continue;
    }
    textReads.push(
      (async () => {
        try {
          const env = tryParseCuratorExport(await file.text());
          return { index: i, env };
        } catch {
          return { index: i, env: null };
        }
      })(),
    );
  }
  for (const { index, env } of await Promise.all(textReads)) {
    if (env) envelopes.push(env);
    else others[index] = files[index]!;
  }
  return { envelopes, others: others.filter((f): f is File => f !== undefined) };
}

async function importEnvelope(env: CuratorExportEnvelope): Promise<void> {
  const ui = useUiStore.getState();
  await ui.withBusy(async () => {
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
  });
  // Resolved rows (matched status) are skipped by both runners; this
  // pass picks up only the unresolved tracks if any are present.
  queuePostIngestRunners();
}

export async function ingestDroppedFiles(files: File[]): Promise<void> {
  const { envelopes, others } = await partitionCuratorExports(files);
  for (const env of envelopes) await importEnvelope(env);
  if (others.length > 0) await addAndEnrich(others);
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
    await ui.withBusy(async () => {
      const tracks = await fetchPlaylistTracks(playlistId, clientId);
      if (tracks.length === 0) {
        ui.pushToast({ kind: "info", message: "Playlist has no tracks" });
        return;
      }
      usePlaylistStore.getState().addTracks(tracks);
      ui.pushToast({
        kind: "success",
        message: `Appended ${tracks.length} tracks from Spotify`,
      });
    });
    queuePostIngestRunners();
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
