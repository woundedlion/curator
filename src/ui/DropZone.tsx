import { useEffect, useState } from "react";
import { walkDataTransferItems } from "../ingest/folderWalker";
import { useUiStore } from "../store/uiStore";
import {
  PLAYLIST_DRAG_MIME,
  getPlaylistIdFromDrag,
} from "./dragData";

type DropKind = "files" | "playlist";

type Props = {
  onFilesDropped: (files: File[]) => void;
  onPlaylistDropped: (playlistId: string) => void;
  recursive: boolean;
};

// Rearmed-by-every-dragover heartbeat. The dragenter/dragleave depth
// counter we used to use was fragile — fast in-and-out drags and child-
// element transitions can leave the depth off by one, sticking the
// overlay open after the user releases. Resetting `active` via a
// timeout that's reset on every dragover means: when drags stop coming
// in, the overlay clears within OVERLAY_CLEAR_MS.
const OVERLAY_CLEAR_MS = 150;

function detectDropKind(dt: DataTransfer | null): DropKind {
  if (!dt) return "files";
  if (dt.types.includes(PLAYLIST_DRAG_MIME)) return "playlist";
  return "files";
}

function dragHasFilesOrPlaylist(dt: DataTransfer | null): boolean {
  if (!dt) return false;
  if (dt.types.includes(PLAYLIST_DRAG_MIME)) return true;
  return dt.types.includes("Files");
}

export function DropZone({
  onFilesDropped,
  onPlaylistDropped,
  recursive,
}: Props) {
  const [active, setActive] = useState<null | DropKind>(null);
  const settingsOpen = useUiStore((state) => state.showSettings);
  const createOpen = useUiStore((state) => state.showCreateDialog);
  const modalOpen = settingsOpen || createOpen;

  useEffect(() => {
    if (modalOpen) {
      // A modal is in front of the canvas — anything dropped here should
      // belong to the modal's input fields (the user dragging text into
      // Settings), not the ingest pipeline. We skip attaching listeners;
      // the overlay is suppressed at render time below.
      return;
    }
    let clearTimer: ReturnType<typeof setTimeout> | null = null;

    function clearOverlaySoon(): void {
      if (clearTimer) clearTimeout(clearTimer);
      clearTimer = setTimeout(() => {
        clearTimer = null;
        setActive(null);
      }, OVERLAY_CLEAR_MS);
    }
    function cancelPendingClear(): void {
      if (clearTimer) {
        clearTimeout(clearTimer);
        clearTimer = null;
      }
    }

    function onOver(event: DragEvent) {
      // The browser only fires "drop" on a target with preventDefault'd
      // dragover. Without this, the drop is consumed by the browser's
      // default file-open handler.
      if (!dragHasFilesOrPlaylist(event.dataTransfer)) return;
      event.preventDefault();
      setActive(detectDropKind(event.dataTransfer));
      cancelPendingClear();
    }
    function onLeave() {
      // Always schedule a clear; dragover will cancel it as long as the
      // drag is still over the window.
      clearOverlaySoon();
    }
    async function onDrop(event: DragEvent) {
      event.preventDefault();
      cancelPendingClear();
      setActive(null);
      if (!event.dataTransfer) return;
      const playlistId = getPlaylistIdFromDrag(event.dataTransfer);
      if (playlistId) {
        onPlaylistDropped(playlistId);
        return;
      }
      const files = await walkDataTransferItems(event.dataTransfer.items, {
        recursive,
      });
      onFilesDropped(files);
    }
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("dragover", onOver);
    window.addEventListener("drop", onDrop);
    return () => {
      cancelPendingClear();
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("drop", onDrop);
    };
  }, [onFilesDropped, onPlaylistDropped, recursive, modalOpen]);

  if (!active || modalOpen) return null;
  return (
    <div
      // Stacked under modal layers (z-50 in SettingsDialog/ConfirmDialog,
      // z-40 in CreatePlaylistPanel). The overlay sits above the table
      // and rubber-band selection but never blocks dialogs.
      className="fixed inset-0 z-40 flex items-center justify-center bg-neutral-900/80 pointer-events-none"
      role="status"
      aria-live="polite"
    >
      <div className="rounded-2xl border-2 border-dashed border-neutral-400 px-12 py-10 text-center">
        {active === "playlist" ? (
          <>
            <p className="text-xl">Drop to append playlist tracks</p>
            <p className="mt-2 text-sm text-neutral-400">
              Appends imported Spotify tracks to the current draft
            </p>
          </>
        ) : (
          <>
            <p className="text-xl">Drop files or folders to add them</p>
            <p className="mt-2 text-sm text-neutral-400">
              Multiple folders accepted · audio, text, or .m3u ·{" "}
              {recursive ? "scanning folders recursively" : "top-level only"}
            </p>
          </>
        )}
      </div>
    </div>
  );
}
