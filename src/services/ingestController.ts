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
    const tracks = await ingestFiles(files);
    if (tracks.length === 0) {
      ui.pushToast({ kind: "info", message: "No ingestible files in drop" });
      return;
    }
    usePlaylistStore.getState().addTracks(tracks);
    ui.pushToast({ kind: "success", message: `Added ${tracks.length} tracks` });
  });

  void useUiStore.getState().withBusy(async () => {
    await matchAllOnSpotify();
    await enrichAllPending();
  });
}

export async function ingestDroppedFiles(files: File[]): Promise<void> {
  await addAndEnrich(files);
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

function fallbackFolderInput(_recursive: boolean): void {
  const input = document.createElement("input");
  input.type = "file";
  input.setAttribute("webkitdirectory", "");
  input.multiple = true;
  input.addEventListener("change", async () => {
    if (!input.files) return;
    await addAndEnrich(Array.from(input.files));
  });
  input.click();
}
