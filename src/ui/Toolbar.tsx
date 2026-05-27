import { useState } from "react";
import { useEnrichmentRemaining } from "../hooks/useEnrichmentRemaining";
import { reenrichAll } from "../services/enrichmentRunner";
import { useSettingsStore } from "../store/settingsStore";
import { usePlaylistStore } from "../store/playlistStore";
import { useUiStore } from "../store/uiStore";
import { BusySpinner } from "./BusySpinner";
import { ConfirmDialog } from "./ConfirmDialog";
import { ConnectionBadge } from "./ConnectionBadge";
import { FilterIcon, GearIcon, TrashIcon, TreeIcon } from "./icons";
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
  const enrichmentRemaining = useEnrichmentRemaining();
  const queueDepth = useUiStore((state) => state.enrichmentQueueDepth);
  // Show the "Enriching" badge whenever EITHER signal says work is in
  // flight. They can race during shutdown (queue cleared before the row
  // count drops, or vice versa); requiring both would hide ongoing work
  // for a brief but visible window. Each signal alone is a reliable
  // "work in progress" indicator, so the OR is correct.
  const isEnriching = queueDepth > 0 || enrichmentRemaining > 0;
  const openSettings = useUiStore((state) => state.setShowSettings);
  const [showClearConfirm, setShowClearConfirm] = useState(false);

  function handleClear() {
    if (trackCount === 0) return;
    setShowClearConfirm(true);
  }

  function confirmClearPlaylist() {
    setShowClearConfirm(false);
    clearPlaylist();
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
            ? "Nothing to re-enrich"
            : "Re-enrich all tracks (clears MusicBrainz cache for the playlist)"
        }
        icon="↻"
        onClick={() => void reenrichAll()}
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
    </header>
  );
}
