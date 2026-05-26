import { useEffect, useState } from "react";
import { walkDataTransferItems } from "../ingest/folderWalker";
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

function detectDropKind(dt: DataTransfer | null): DropKind {
  if (!dt) return "files";
  if (dt.types.includes(PLAYLIST_DRAG_MIME)) return "playlist";
  return "files";
}

export function DropZone({
  onFilesDropped,
  onPlaylistDropped,
  recursive,
}: Props) {
  const [active, setActive] = useState<null | DropKind>(null);

  useEffect(() => {
    let depth = 0;
    function onEnter(event: DragEvent) {
      if (!event.dataTransfer) return;
      depth++;
      setActive(detectDropKind(event.dataTransfer));
      event.preventDefault();
    }
    function onLeave() {
      depth = Math.max(0, depth - 1);
      if (depth === 0) setActive(null);
    }
    function onOver(event: DragEvent) {
      event.preventDefault();
    }
    async function onDrop(event: DragEvent) {
      event.preventDefault();
      depth = 0;
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
    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("dragover", onOver);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("drop", onDrop);
    };
  }, [onFilesDropped, onPlaylistDropped, recursive]);

  if (!active) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-neutral-900/80 pointer-events-none">
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
