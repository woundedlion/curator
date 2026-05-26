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

  void useUiStore.getState().withBusy(async () => {
    await matchAllOnSpotify();
    await enrichAllPending();
  });
}

// Read text files once up front so we can route Curator-export drops to
// the rich importer (metadata restoration + per-file toast) and leave
// everything else to the existing ingest pipeline. Files that read fail
// fall through as "others" — the downstream parser will surface its own
// error rather than us swallowing it here.
async function partitionCuratorExports(
  files: File[],
): Promise<{ envelopes: CuratorExportEnvelope[]; others: File[] }> {
  const envelopes: CuratorExportEnvelope[] = [];
  const others: File[] = [];
  for (const file of files) {
    if (!isTextFile(file.name)) {
      others.push(file);
      continue;
    }
    try {
      const content = await file.text();
      const env = tryParseCuratorExport(content);
      if (env) envelopes.push(env);
      else others.push(file);
    } catch {
      others.push(file);
    }
  }
  return { envelopes, others };
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
  void useUiStore.getState().withBusy(async () => {
    await matchAllOnSpotify();
    await enrichAllPending();
  });
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
    void useUiStore.getState().withBusy(async () => {
      await enrichAllPending();
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
    } catch {
      // user cancelled
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
