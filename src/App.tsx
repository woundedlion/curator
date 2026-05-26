import { useCallback, useState } from "react";
import { useAppBootstrap } from "./hooks/useAppBootstrap";
import { useVisibleTrackIds } from "./hooks/useVisibleTrackIds";
import { useSettingsStore } from "./store/settingsStore";
import { usePlaylistStore } from "./store/playlistStore";
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

  const handleFiles = useCallback((files: File[]) => {
    void ingestDroppedFiles(files);
  }, []);

  const handlePlaylistDrop = useCallback((playlistId: string) => {
    void importPlaylistById(playlistId);
  }, []);

  const handleReEnrich = useCallback((trackId: string) => {
    void reenrichTrack(trackId);
  }, []);

  const handleRemove = useCallback((trackId: string) => {
    usePlaylistStore.getState().removeTrack(trackId);
  }, []);

  return (
    <div className="flex h-full flex-col">
      <Toolbar hiddenCount={hiddenCount} onPickFolder={pickFolderAndIngest} />
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <main className="flex min-w-0 flex-1 flex-col">
          {trackCount === 0 ? (
            <EmptyState onPickFolder={pickFolderAndIngest} />
          ) : (
            <PlaylistTable
              visibleTrackIds={visibleTrackIds}
              onPickSpotifyMatch={setSpotifyPickerTrackId}
              onPickEnrichmentMatch={setEnrichmentPickerTrackId}
              onReEnrich={handleReEnrich}
              onRemove={handleRemove}
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
      <AmbiguousMatchDialog
        trackId={spotifyPickerTrackId}
        onClose={() => setSpotifyPickerTrackId(null)}
      />
      <AmbiguousEnrichmentDialog
        trackId={enrichmentPickerTrackId}
        onClose={() => setEnrichmentPickerTrackId(null)}
      />
      <ToastList />
    </div>
  );
}
