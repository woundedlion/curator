import { useCallback, useState } from "react";
import { useAppBootstrap } from "./hooks/useAppBootstrap";
import { useVisibleTrackIds } from "./hooks/useVisibleTrackIds";
import { useSettingsStore } from "./store/settingsStore";
import { usePlaylistStore } from "./store/playlistStore";
import { useUiStore } from "./store/uiStore";
import { EmptyFilterState } from "./ui/EmptyFilterState";
import { ErrorBoundary } from "./ui/ErrorBoundary";
import {
  importPlaylistById,
  ingestDroppedFiles,
  pickFolderAndIngest,
} from "./services/ingestController";
import { reenrichTrack } from "./services/enrichmentRunner";
import { AddTrackDialog } from "./ui/AddTrackDialog";
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
  const showAddTrack = useUiStore((state) => state.showAddTrack);
  const setShowAddTrack = useUiStore((state) => state.setShowAddTrack);

  // ─── Rapid disambiguation workflow (DESIGN §4.7.5) ───────────────────────
  // `disambiguation` holds the snapshot of work-item track ids taken when
  // the workflow started plus the current position. The picker shown for
  // the current item carries the workflow chrome; picking or skipping
  // advances to the next still-unresolved item; exhausting the snapshot (or
  // Stop/Esc) ends the pass.
  const [disambiguation, setDisambiguation] = useState<{
    ids: string[];
    pos: number;
  } | null>(null);

  const startDisambiguation = useCallback(() => {
    const store = usePlaylistStore.getState();
    // Snapshot only VISIBLE rows in visible order — when Hide-unmatched is
    // on, `missing` rows are filtered out of the table, so the workflow
    // shouldn't surface them either. `visibleTrackIds` already encodes that
    // rule (useVisibleTrackIds), so intersecting with it keeps the cycle in
    // sync with what the user can see.
    const ids = visibleTrackIds.filter((id) => {
      const status = store.tracksById[id]?.spotify.status;
      return status === "ambiguous" || status === "missing";
    });
    if (ids.length === 0) return;
    setDisambiguation({ ids, pos: 0 });
    setSpotifyPickerTrackId(ids[0]!);
  }, [visibleTrackIds]);

  const stopDisambiguation = useCallback(() => {
    setDisambiguation(null);
    setSpotifyPickerTrackId(null);
  }, []);

  // Step back to the immediately-preceding work item in the snapshot so the
  // user can revisit / correct a row they already passed (Left arrow / Back).
  // Unlike forward advance this does NOT skip resolved rows — going back is an
  // explicit "let me look at that one again". No-op at the first item.
  const goBackDisambiguation = useCallback(() => {
    if (!disambiguation) return;
    const { ids, pos } = disambiguation;
    if (pos <= 0) return;
    const prev = pos - 1;
    setDisambiguation({ ids, pos: prev });
    setSpotifyPickerTrackId(ids[prev]!);
  }, [disambiguation]);

  const advanceDisambiguation = useCallback(() => {
    if (!disambiguation) return;
    const store = usePlaylistStore.getState();
    const { ids, pos } = disambiguation;
    // Walk forward to the next item that STILL needs a decision — a row a
    // background search promoted to `matched` out from under us is skipped.
    for (let i = pos + 1; i < ids.length; i++) {
      const id = ids[i]!;
      const status = store.tracksById[id]?.spotify.status;
      if (status === "ambiguous" || status === "missing") {
        setDisambiguation({ ids, pos: i });
        setSpotifyPickerTrackId(id);
        return;
      }
    }
    // Snapshot exhausted — report how many of the work items ended matched.
    const resolved = ids.filter(
      (id) => store.tracksById[id]?.spotify.status === "matched",
    ).length;
    useUiStore.getState().pushToast({
      kind: "info",
      message: `Resolved ${resolved} of ${ids.length} track${ids.length === 1 ? "" : "s"}`,
    });
    setDisambiguation(null);
    setSpotifyPickerTrackId(null);
  }, [disambiguation]);

  const closeSpotifyPicker = useCallback(() => {
    if (disambiguation) {
      stopDisambiguation();
    } else {
      setSpotifyPickerTrackId(null);
    }
  }, [disambiguation, stopDisambiguation]);

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
      {/* ToastList sits OUTSIDE the boundary so toasts (incl. ones the
          boundary itself might want to emit later) survive a render
          crash in the main tree. */}
      <ErrorBoundary>
        <Toolbar
          hiddenCount={hiddenCount}
          onPickFolder={pickFolderAndIngest}
          onStartDisambiguation={startDisambiguation}
        />
        <div className="flex min-h-0 flex-1">
          <Sidebar />
          <main className="flex min-w-0 flex-1 flex-col">
            {trackCount === 0 ? (
              <EmptyState onPickFolder={pickFolderAndIngest} />
            ) : visibleTrackIds.length === 0 ? (
              <EmptyFilterState hiddenCount={hiddenCount} />
            ) : (
              // Nested boundary: a render throw in a single row (malformed
              // track, virtualizer edge) localizes to the table region —
              // the toolbar, sidebar, and now-playing bar stay live, and
              // Continue remounts just the table.
              <ErrorBoundary
                fallback={({ retry }) => (
                  <div
                    role="alert"
                    className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-sm text-neutral-400"
                  >
                    <p>The track list hit an unexpected error.</p>
                    <button
                      type="button"
                      onClick={retry}
                      className="rounded border border-neutral-700 px-3 py-1 hover:bg-neutral-800"
                    >
                      Reload list
                    </button>
                  </div>
                )}
              >
                <PlaylistTable
                  visibleTrackIds={visibleTrackIds}
                  onPickSpotifyMatch={setSpotifyPickerTrackId}
                  onPickEnrichmentMatch={setEnrichmentPickerTrackId}
                  onReEnrich={handleReEnrich}
                />
              </ErrorBoundary>
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
        {/* Nested boundary around the dialog host: a render throw inside a
            dialog dismisses just the dialog (fallback renders nothing) and
            leaves the main view interactive, rather than tearing down the
            whole app shell. The user can reopen the dialog. */}
        <ErrorBoundary fallback={() => null}>
          <SettingsDialog />
          {showAddTrack && (
            <AddTrackDialog onClose={() => setShowAddTrack(false)} />
          )}
          {spotifyPickerTrackId !== null && (
            // `key` gives each picker session a fresh component instance so
            // the dialog's form state initializes via standard useState,
            // not a render-phase reset (see useState §"Storing information
            // from previous renders" — equivalent semantic, clearer intent).
            // In the disambiguation workflow the key also forces a clean
            // remount as the queue advances from one track to the next.
            <AmbiguousMatchDialog
              key={spotifyPickerTrackId}
              trackId={spotifyPickerTrackId}
              onClose={closeSpotifyPicker}
              workflow={
                disambiguation
                  ? {
                      position: disambiguation.pos + 1,
                      total: disambiguation.ids.length,
                      onSkip: advanceDisambiguation,
                      onResolved: advanceDisambiguation,
                      onBack: goBackDisambiguation,
                    }
                  : undefined
              }
            />
          )}
          <AmbiguousEnrichmentDialog
            trackId={enrichmentPickerTrackId}
            onClose={() => setEnrichmentPickerTrackId(null)}
          />
        </ErrorBoundary>
      </ErrorBoundary>
      <ToastList />
    </div>
  );
}
