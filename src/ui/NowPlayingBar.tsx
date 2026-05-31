import { useCallback, useState, type KeyboardEvent } from "react";
import { usePlaybackStore } from "../playback/playbackStore";
import type { PlaybackSource } from "../playback/playbackSource";
import { formatDuration } from "../util/duration";
import { PauseIcon, PlayIcon, StopIcon } from "./icons";

// Read the authoritative label off the source itself rather than
// re-deriving one from `kind` — the source already carries the canonical
// string (see createPlaybackSource), so duplicating the mapping here would
// silently drift if a label is ever reworded in one place.
function sourceLabel(source: PlaybackSource): string {
  return source.kind === "none" ? "—" : source.label;
}

export function NowPlayingBar() {
  const currentTrackId = usePlaybackStore((state) => state.currentTrackId);
  const currentSource = usePlaybackStore((state) => state.currentSource);
  const currentDisplay = usePlaybackStore((state) => state.currentDisplay);
  const isPlaying = usePlaybackStore((state) => state.isPlaying);
  const positionMs = usePlaybackStore((state) => state.positionMs);
  const durationMs = usePlaybackStore((state) => state.durationMs);
  const toggle = usePlaybackStore((state) => state.toggle);
  const stop = usePlaybackStore((state) => state.stop);
  const seek = usePlaybackStore((state) => state.seek);

  // While the user is actively dragging the slider, we render `dragValue`
  // instead of the live `positionMs` so the thumb doesn't fight the audio
  // events. Commit the seek once the user releases.
  const [dragValue, setDragValue] = useState<number | null>(null);

  // If the current track changes mid-drag (e.g. SDK loads a new uri),
  // drop the pending drag value rather than seeking the new track to
  // the prior position. This is the documented "storing information
  // from previous renders" pattern
  // (https://react.dev/reference/react/useState#storing-information-from-previous-renders),
  // not a side-effect-in-render violation — comparing a tracked prior
  // value to the current render's value and resetting derived state
  // during render is the explicit React idiom.
  const [lastTrackId, setLastTrackId] = useState(currentTrackId);
  if (lastTrackId !== currentTrackId) {
    setLastTrackId(currentTrackId);
    setDragValue(null);
  }

  const commitSeek = useCallback(() => {
    if (dragValue === null) return;
    seek(dragValue);
    setDragValue(null);
  }, [dragValue, seek]);

  const handleKeyUp = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (dragValue === null) return;
      if (
        e.key === "ArrowLeft" ||
        e.key === "ArrowRight" ||
        e.key === "PageDown" ||
        e.key === "PageUp" ||
        e.key === "Home" ||
        e.key === "End"
      ) {
        commitSeek();
      }
    },
    [commitSeek, dragValue],
  );

  // The bar stays visible as long as ANY of these is true: there's a
  // current track id, audio is actively playing, or we have a display
  // payload. The Player keeps these in sync; the triple-check is
  // defense in depth so a bug in one mirror can't strand audio with
  // no user-visible Stop control.
  if (!currentTrackId && !isPlaying && !currentDisplay) return null;

  // `currentTrackId` is a real Track id for table-driven playback and the
  // synthetic `candidate:{uri}` form for dialog-driven candidate previews.
  // Only the former is a valid `toggle()` argument; the latter is owned by
  // the dialog and toggled from inside it. (Stop still works either way.)
  const canToggleFromHere =
    currentTrackId !== null && !currentTrackId.startsWith("candidate:");

  const sliderValue = dragValue ?? positionMs;
  // The slider is operable any time we know the duration. Without a duration
  // (SDK starting up, or HTMLAudio before `loadedmetadata`) it stays inert.
  const seekable = durationMs > 0;

  return (
    <footer
      className="flex flex-col gap-1 border-t border-neutral-800 bg-neutral-900 px-4 py-2 text-sm"
      role="region"
      aria-label="Now playing"
    >
      <div className="flex items-center gap-3">
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
          <div className="truncate font-medium">
            {currentDisplay?.title ?? "Now playing"}
          </div>
          <div className="truncate text-xs text-neutral-400">
            {currentDisplay?.artist ?? "—"} · {sourceLabel(currentSource)}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-3 pl-12">
        <span
          className="w-10 shrink-0 text-right text-xs tabular-nums text-neutral-400"
          aria-hidden
        >
          {formatDuration(sliderValue)}
        </span>
        <input
          type="range"
          min={0}
          max={seekable ? durationMs : 0}
          step={1000}
          value={seekable ? sliderValue : 0}
          disabled={!seekable}
          onChange={(e) => setDragValue(Number(e.target.value))}
          onPointerUp={commitSeek}
          // A cancelled pointer gesture (interrupted by a scroll/gesture
          // takeover) must not freeze the thumb at a dragged-but-uncommitted
          // value — drop the pending drag so the live playhead resumes.
          onPointerCancel={() => setDragValue(null)}
          onKeyUp={handleKeyUp}
          aria-label="Seek"
          // Native <input type="range"> derives valuemin/max/now from
          // min/max/value, so only aria-valuetext is worth setting — it
          // overrides the spoken value with the mm:ss form.
          aria-valuetext={`${formatDuration(sliderValue)} of ${formatDuration(durationMs)}`}
          className="h-1 min-w-0 flex-1 cursor-pointer appearance-none rounded bg-neutral-700 accent-matched disabled:cursor-not-allowed disabled:opacity-50"
        />
        <span
          className="w-10 shrink-0 text-xs tabular-nums text-neutral-400"
          aria-hidden
        >
          {formatDuration(durationMs)}
        </span>
      </div>
    </footer>
  );
}
