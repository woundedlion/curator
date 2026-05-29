import { useCallback, useState } from "react";
import { useAppBootstrap } from "./hooks/useAppBootstrap";
import { useVisibleTrackIds } from "./hooks/useVisibleTrackIds";
import { useSettingsStore } from "./store/settingsStore";
import { usePlaylistStore } from "./store/playlistStore";
import { EmptyFilterState } from "./ui/EmptyFilterState";
import {
  importPlaylistById,
  ingestDroppedFiles,
  pickFolderAndIngest,
} from "./services/ingestController";
import { reenrichTrack } from "./services/enrichmentRunner";
import { AmbiguousEnrichmentDialog } from "./ui/AmbiguousEnrichmentDialog";
import { AmbiguousMatchDialog } from "./ui/AmbiguousMatchDialog";
import { CreatePlaylistPanel } from "./ui/CreatePlaylistPanel";
import { DropZone } from "./ui/DropZone";
import { EmptyState } from "./ui/EmptyState";
import { NowPlayingBar } from "./ui/NowPlayingBar";
import { PlaylistTable } from "./ui/PlaylistTable";
import { SettingsDialog } from "./ui/SettingsDialog";
import { Sidebar } from "./ui/Sidebar";
import { ToastList } from "./ui/ToastList";
import { Toolbar } from "./ui/Toolbar";

export function App() {
  useAppBootstrap();
  const recursive = useSettingsStore(
    (state) => state.settings.recursiveFolderScan,
  );
  const trackCount = usePlaylistStore((state) => state.playlist.trackIds.length);
  const { visibleTrackIds, hiddenCount } = useVisibleTrackIds();
  const [spotifyPickerTrackId, setSpotifyPickerTrackId] = useState<string | null>(
    null,
  );
  const [enrichmentPickerTrackId, setEnrichmentPickerTrackId] = useState<
    string | null
  >(null);

  // The runners toast their own user-visible errors; the .catch is
  // belt-and-suspenders for unexpected exceptions outside those paths
  // so an unhandled rejection doesn't bubble to the console silently.
  const handleFiles = useCallback((files: File[]) => {
    ingestDroppedFiles(files).catch((error) => {
      console.error("ingestDroppedFiles crashed", error);
    });
  }, []);

  const handlePlaylistDrop = useCallback((playlistId: string) => {
    importPlaylistById(playlistId).catch((error) => {
      console.error("importPlaylistById crashed", error);
    });
  }, []);

  const handleReEnrich = useCallback((trackId: string) => {
    reenrichTrack(trackId).catch((error) => {
      console.error("reenrichTrack crashed", error);
    });
  }, []);

  return (
    <div className="flex h-full flex-col">
      <Toolbar hiddenCount={hiddenCount} onPickFolder={pickFolderAndIngest} />
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <main className="flex min-w-0 flex-1 flex-col">
          {trackCount === 0 ? (
            <EmptyState onPickFolder={pickFolderAndIngest} />
          ) : visibleTrackIds.length === 0 ? (
            <EmptyFilterState hiddenCount={hiddenCount} />
          ) : (
            <PlaylistTable
              visibleTrackIds={visibleTrackIds}
              onPickSpotifyMatch={setSpotifyPickerTrackId}
              onPickEnrichmentMatch={setEnrichmentPickerTrackId}
              onReEnrich={handleReEnrich}
            />
          )}
          <CreatePlaylistPanel />
        </main>
      </div>
      <NowPlayingBar />

      <DropZone
        onFilesDropped={handleFiles}
        onPlaylistDropped={handlePlaylistDrop}
        recursive={recursive}
      />
      <SettingsDialog />
      {spotifyPickerTrackId !== null && (
        // `key` gives each picker session a fresh component instance so
        // the dialog's form state initializes via standard useState,
        // not a render-phase reset (see useState §"Storing information
        // from previous renders" — equivalent semantic, clearer intent).
        <AmbiguousMatchDialog
          key={spotifyPickerTrackId}
          trackId={spotifyPickerTrackId}
          onClose={() => setSpotifyPickerTrackId(null)}
        />
      )}
      <AmbiguousEnrichmentDialog
        trackId={enrichmentPickerTrackId}
        onClose={() => setEnrichmentPickerTrackId(null)}
      />
      <ToastList />
    </div>
  );
}
