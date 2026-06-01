import { useState } from "react";
import { useEnrichmentRemaining } from "../hooks/useEnrichmentRemaining";
import { useSpotifyRemaining } from "../hooks/useSpotifyRemaining";
import { reenrichAll } from "../services/enrichmentRunner";
import { useSettingsStore } from "../store/settingsStore";
import { usePlaylistStore } from "../store/playlistStore";
import { useUiStore } from "../store/uiStore";
import { BusySpinner } from "./BusySpinner";
import { ConfirmDialog } from "./ConfirmDialog";
import { ConnectionBadge } from "./ConnectionBadge";
import {
  FilterIcon,
  FolderAddIcon,
  GearIcon,
  PlayIcon,
  PlusIcon,
  RefreshIcon,
  ResolveIcon,
  TrashIcon,
  TreeIcon,
  UndoIcon,
} from "./icons";
import { IconButton } from "./IconButton";
import { ToggleIconButton } from "./ToggleIconButton";

type Props = {
  hiddenCount: number;
  onPickFolder: () => void;
  // Kick off the rapid-disambiguation workflow (§4.7.5). Owned by App so it
  // can drive the picker queue; the Toolbar only triggers it and reflects
  // whether there's anything to resolve.
  onStartDisambiguation: () => void;
};

export function Toolbar({
  hiddenCount,
  onPickFolder,
  onStartDisambiguation,
}: Props) {
  const settings = useSettingsStore((state) => state.settings);
  const updateSettings = useSettingsStore((state) => state.update);
  const hideUnmatched = usePlaylistStore(
    (state) => state.playlist.hideUnmatched,
  );
  const setHideUnmatched = usePlaylistStore((state) => state.setHideUnmatched);
  const trackCount = usePlaylistStore((state) => state.playlist.trackIds.length);
  // Count of rows still needing a Spotify decision (drives the
  // Resolve-ambiguous button's enabled state). Mirrors what the workflow
  // actually cycles: it respects Hide-unmatched, so a `missing` row counts
  // only when it's still visible (the useVisibleTrackIds rule). Returns a
  // primitive so the selector's referential-equality check doesn't re-render
  // spuriously.
  const unresolvedCount = usePlaylistStore((state) => {
    const hide = state.playlist.hideUnmatched;
    let n = 0;
    for (const id of state.playlist.trackIds) {
      const status = state.tracksById[id]?.spotify.status;
      if (status === "ambiguous") n++;
      else if (status === "missing" && !hide) n++;
    }
    return n;
  });
  const canUndo = usePlaylistStore((state) => state.undoStack.length > 0);
  const undo = usePlaylistStore((state) => state.undo);
  const clearPlaylist = usePlaylistStore((state) => state.clearPlaylist);
  const nukeEnrichmentState = usePlaylistStore(
    (state) => state.nukeEnrichmentState,
  );
  const enrichmentRemaining = useEnrichmentRemaining();
  const queueDepth = useUiStore((state) => state.enrichmentQueueDepth);
  const spotifyRemaining = useSpotifyRemaining();
  // Show the "Enriching" badge whenever EITHER signal says work is in
  // flight. They can race during shutdown (queue cleared before the row
  // count drops, or vice versa); requiring both would hide ongoing work
  // for a brief but visible window. Each signal alone is a reliable
  // "work in progress" indicator, so the OR is correct.
  const isEnriching = queueDepth > 0 || enrichmentRemaining > 0;
  const openSettings = useUiStore((state) => state.setShowSettings);
  const openAddTrack = useUiStore((state) => state.setShowAddTrack);
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [showRefreshConfirm, setShowRefreshConfirm] = useState(false);

  function handleClear() {
    if (trackCount === 0) return;
    setShowClearConfirm(true);
  }

  function confirmClearPlaylist() {
    setShowClearConfirm(false);
    clearPlaylist();
  }

  function handleRefresh() {
    if (trackCount === 0) return;
    setShowRefreshConfirm(true);
  }

  function confirmRefresh() {
    setShowRefreshConfirm(false);
    nukeEnrichmentState();
    runReenrichAll();
  }

  // reenrichAll surfaces its own user-visible errors via toasts; this
  // wrapper exists so an UNEXPECTED crash (e.g. a Zustand store throw)
  // doesn't slip out as an unhandled rejection. It's only a console.error
  // path — the user has already been informed of any handled failure.
  function runReenrichAll(): void {
    reenrichAll().catch((error) => {
      console.error("reenrichAll crashed", error);
    });
  }

  return (
    <>
    <header
      className="sticky top-0 z-30 flex items-center gap-3 border-b border-neutral-800 bg-neutral-950/85 px-4 py-3 shadow-lg backdrop-blur"
      role="banner"
    >
      <h1 className="text-lg font-semibold tracking-tight">Curator</h1>

      <ToggleIconButton
        label={
          settings.recursiveFolderScan
            ? "Recursive folder scan: on"
            : "Recursive folder scan: off"
        }
        icon={<TreeIcon />}
        active={settings.recursiveFolderScan}
        onClick={() =>
          updateSettings({
            recursiveFolderScan: !settings.recursiveFolderScan,
          })
        }
      />

      <ToggleIconButton
        label={
          hideUnmatched
            ? `Hide unmatched: on (${hiddenCount} hidden)`
            : "Hide unmatched: off"
        }
        icon={<FilterIcon />}
        active={hideUnmatched}
        onClick={() => setHideUnmatched(!hideUnmatched)}
      />

      <IconButton
        label="Add files or folder"
        icon={<FolderAddIcon />}
        onClick={onPickFolder}
      />
      <IconButton
        label="Add a track from Spotify"
        icon={<PlusIcon />}
        onClick={() => openAddTrack(true)}
      />
      <IconButton
        label={canUndo ? "Undo last addition" : "Nothing to undo"}
        icon={<UndoIcon />}
        onClick={undo}
        disabled={!canUndo}
      />
      <IconButton
        label={trackCount === 0 ? "Playlist is empty" : "Clear playlist"}
        icon={<TrashIcon />}
        onClick={handleClear}
        disabled={trackCount === 0}
      />
      <IconButton
        label={
          trackCount === 0
            ? "Nothing to resume"
            : "Resume: restart lookups for unresolved tracks only"
        }
        icon={<PlayIcon />}
        onClick={runReenrichAll}
        disabled={trackCount === 0}
      />
      <IconButton
        label={
          trackCount === 0
            ? "Nothing to refresh"
            : "Refresh: wipe all Spotify and MusicBrainz state, then re-run lookups"
        }
        icon={<RefreshIcon />}
        onClick={handleRefresh}
        disabled={trackCount === 0}
      />
      <IconButton
        label={
          unresolvedCount === 0
            ? "No ambiguous or missing tracks to resolve"
            : `Resolve ${unresolvedCount} ambiguous/missing track${unresolvedCount === 1 ? "" : "s"} one by one`
        }
        icon={<ResolveIcon />}
        onClick={onStartDisambiguation}
        disabled={unresolvedCount === 0}
      />

      <div className="ml-auto flex items-center gap-3">
        {/* aria-live="off": the visible text updates live, but we do NOT
            announce every decrement. During a 500-track import these
            counters tick down many times a second, and a polite live
            region would queue a torrent of "N remaining" announcements
            that drowns out everything else and lags far behind reality.
            The presence/absence of the region (work started / finished)
            is the meaningful signal for AT; the running count is a
            sighted-user affordance. */}
        {isEnriching && (
          <span
            className="text-xs text-neutral-400 tabular-nums"
            aria-live="off"
          >
            Enriching · {enrichmentRemaining} remaining
          </span>
        )}
        {spotifyRemaining > 0 && (
          <span
            className="text-xs text-neutral-400 tabular-nums"
            aria-live="off"
            title="Tracks not yet resolved on Spotify"
          >
            Spotify · {spotifyRemaining} remaining
          </span>
        )}
        <BusySpinner />
        <ConnectionBadge />
        <IconButton
          label="Settings"
          icon={<GearIcon />}
          onClick={() => openSettings(true)}
        />
      </div>
    </header>
    {/* Dialogs render as siblings of <header> rather than children: the
        header's backdrop-blur creates a containing block for fixed-position
        descendants, which would clip the dialog to the header bar. */}
    <ConfirmDialog
      open={showClearConfirm}
      title="Clear playlist?"
      message="All tracks will be removed from the current draft. You can undo this while the tab is open."
      confirmLabel="Clear"
      kind="danger"
      onConfirm={confirmClearPlaylist}
      onCancel={() => setShowClearConfirm(false)}
    />
    <ConfirmDialog
      open={showRefreshConfirm}
      title="Refresh all enrichment state?"
      message="Every track's Spotify and MusicBrainz state will be reset to idle and lookups will re-run from scratch. Tracks themselves stay in the playlist — but their match status, candidate lists, and selected URIs are wiped. You can undo this while the tab is open."
      confirmLabel="Refresh"
      kind="danger"
      onConfirm={confirmRefresh}
      onCancel={() => setShowRefreshConfirm(false)}
    />
    </>
  );
}
