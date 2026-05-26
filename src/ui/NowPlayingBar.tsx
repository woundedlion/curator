import { usePlaybackStore } from "../playback/playbackStore";
import { usePlaylistStore } from "../store/playlistStore";
import { PauseIcon, PlayIcon, StopIcon } from "./icons";

function sourceLabel(kind: string): string {
  if (kind === "local") return "Local file";
  if (kind === "spotify-preview") return "Spotify preview (30s)";
  return "—";
}

export function NowPlayingBar() {
  const currentTrackId = usePlaybackStore((state) => state.currentTrackId);
  const currentSource = usePlaybackStore((state) => state.currentSource);
  const isPlaying = usePlaybackStore((state) => state.isPlaying);
  const toggle = usePlaybackStore((state) => state.toggle);
  const stop = usePlaybackStore((state) => state.stop);
  const track = usePlaylistStore((state) =>
    currentTrackId ? state.tracksById[currentTrackId] : null,
  );

  if (!track) return null;

  return (
    <footer
      className="flex items-center gap-3 border-t border-neutral-800 bg-neutral-900 px-4 py-2 text-sm"
      role="contentinfo"
      aria-label="Now playing"
    >
      <button
        type="button"
        aria-label={isPlaying ? "Pause" : "Play"}
        title={isPlaying ? "Pause" : "Play"}
        onClick={() => toggle(track.id)}
        className="inline-flex items-center justify-center bg-transparent px-2 py-1 text-matched transition-opacity hover:opacity-80"
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
        <div className="truncate font-medium">
          {track.title ?? "Unknown title"}
        </div>
        <div className="truncate text-xs text-neutral-400">
          {track.artist ?? "Unknown artist"} ·{" "}
          {sourceLabel(currentSource.kind)}
        </div>
      </div>
    </footer>
  );
}
