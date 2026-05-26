import { usePlaybackStore } from "../playback/playbackStore";
import { PauseIcon, PlayIcon, StopIcon } from "./icons";

function sourceLabel(kind: string): string {
  if (kind === "local") return "Local file";
  if (kind === "spotify-sdk") return "Spotify (full track)";
  if (kind === "spotify-preview") return "Spotify preview (30s)";
  return "—";
}

export function NowPlayingBar() {
  const currentTrackId = usePlaybackStore((state) => state.currentTrackId);
  const currentSource = usePlaybackStore((state) => state.currentSource);
  const currentDisplay = usePlaybackStore((state) => state.currentDisplay);
  const isPlaying = usePlaybackStore((state) => state.isPlaying);
  const toggle = usePlaybackStore((state) => state.toggle);
  const stop = usePlaybackStore((state) => state.stop);

  if (!currentTrackId || !currentDisplay) return null;

  // `currentTrackId` is a real Track id for table-driven playback and the
  // synthetic `candidate:{uri}` form for dialog-driven candidate previews.
  // Only the former is a valid `toggle()` argument; the latter is owned by
  // the dialog and toggled from inside it.
  const canToggleFromHere = !currentTrackId.startsWith("candidate:");

  return (
    <footer
      className="flex items-center gap-3 border-t border-neutral-800 bg-neutral-900 px-4 py-2 text-sm"
      role="region"
      aria-label="Now playing"
    >
      <button
        type="button"
        aria-label={isPlaying ? "Pause" : "Play"}
        title={isPlaying ? "Pause" : "Play"}
        onClick={() => {
          if (canToggleFromHere) toggle(currentTrackId);
        }}
        disabled={!canToggleFromHere}
        className="inline-flex items-center justify-center bg-transparent px-2 py-1 text-matched transition-opacity hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {isPlaying ? <PauseIcon /> : <PlayIcon />}
      </button>
      <button
        type="button"
        aria-label="Stop"
        title="Stop"
        onClick={stop}
        className="inline-flex items-center justify-center bg-transparent px-2 py-1 text-matched transition-opacity hover:opacity-80"
      >
        <StopIcon />
      </button>
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium">{currentDisplay.title}</div>
        <div className="truncate text-xs text-neutral-400">
          {currentDisplay.artist} · {sourceLabel(currentSource.kind)}
        </div>
      </div>
    </footer>
  );
}
