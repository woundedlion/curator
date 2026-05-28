import { useState } from "react";
import { useEnrichmentRemaining } from "../hooks/useEnrichmentRemaining";
import { useSpotifyQueueDepth } from "../hooks/useSpotifyQueueDepth";
import { reenrichAll } from "../services/enrichmentRunner";
import { useSettingsStore } from "../store/settingsStore";
import { usePlaylistStore } from "../store/playlistStore";
import { useUiStore } from "../store/uiStore";
import { BusySpinner } from "./BusySpinner";
import { ConfirmDialog } from "./ConfirmDialog";
import { ConnectionBadge } from "./ConnectionBadge";
import {
  FilterIcon,
  GearIcon,
  MushroomCloudIcon,
  TrashIcon,
  TreeIcon,
} from "./icons";
import { IconButton } from "./IconButton";
import { ToggleIconButton } from "./ToggleIconButton";

type Props = {
  hiddenCount: number;
  onPickFolder: () => void;
};

export function Toolbar({ hiddenCount, onPickFolder }: Props) {
  const settings = useSettingsStore((state) => state.settings);
  const updateSettings = useSettingsStore((state) => state.update);
  const hideUnmatched = usePlaylistStore(
    (state) => state.playlist.hideUnmatched,
  );
  const setHideUnmatched = usePlaylistStore((state) => state.setHideUnmatched);
  const trackCount = usePlaylistStore((state) => state.playlist.trackIds.length);
  const canUndo = usePlaylistStore((state) => state.undoStack.length > 0);
  const undo = usePlaylistStore((state) => state.undo);
  const clearPlaylist = usePlaylistStore((state) => state.clearPlaylist);
  const nukeEnrichmentState = usePlaylistStore(
    (state) => state.nukeEnrichmentState,
  );
  const enrichmentRemaining = useEnrichmentRemaining();
  const queueDepth = useUiStore((state) => state.enrichmentQueueDepth);
  const spotifyQueueDepth = useSpotifyQueueDepth();
  // Show the "Enriching" badge whenever EITHER signal says work is in
  // flight. They can race during shutdown (queue cleared before the row
  // count drops, or vice versa); requiring both would hide ongoing work
  // for a brief but visible window. Each signal alone is a reliable
  // "work in progress" indicator, so the OR is correct.
  const isEnriching = queueDepth > 0 || enrichmentRemaining > 0;
  const openSettings = useUiStore((state) => state.setShowSettings);
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [showNukeConfirm, setShowNukeConfirm] = useState(false);

  function handleClear() {
    if (trackCount === 0) return;
    setShowClearConfirm(true);
  }

  function confirmClearPlaylist() {
    setShowClearConfirm(false);
    clearPlaylist();
  }

  function handleNuke() {
    if (trackCount === 0) return;
    setShowNukeConfirm(true);
  }

  function confirmNuke() {
    setShowNukeConfirm(false);
    nukeEnrichmentState();
  }

  return (
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

      <IconButton label="Add files or folder" icon="+" onClick={onPickFolder} />
      <IconButton
        label={canUndo ? "Undo last addition" : "Nothing to undo"}
        icon="↶"
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
            ? "Nothing to look up"
            : "Resume lookups for tracks not yet looked up (Spotify or MusicBrainz)"
        }
        icon="↻"
        onClick={() => void reenrichAll()}
        disabled={trackCount === 0}
      />
      <IconButton
        label={
          trackCount === 0
            ? "Nothing to reset"
            : "Reset all Spotify and MusicBrainz state back to idle"
        }
        icon={<MushroomCloudIcon />}
        onClick={handleNuke}
        disabled={trackCount === 0}
      />

      <div className="ml-auto flex items-center gap-3">
        {isEnriching && (
          <span
            className="text-xs text-neutral-400 tabular-nums"
            aria-live="polite"
          >
            Enriching · {enrichmentRemaining} remaining
          </span>
        )}
        {spotifyQueueDepth > 0 && (
          <span
            className="text-xs text-neutral-400 tabular-nums"
            aria-live="polite"
            title="Spotify requests waiting on the rate-limit queue"
          >
            Spotify · {spotifyQueueDepth} queued
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
        open={showNukeConfirm}
        title="Reset all enrichment state?"
        message="Every track's Spotify and MusicBrainz state will be reset to idle. Tracks themselves stay in the playlist — but their match status, candidate lists, and selected URIs are wiped. The toolbar's resume button will re-search all of them. You can undo this while the tab is open."
        confirmLabel="Reset"
        kind="danger"
        onConfirm={confirmNuke}
        onCancel={() => setShowNukeConfirm(false)}
      />
    </header>
  );
}
