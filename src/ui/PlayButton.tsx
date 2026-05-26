import { usePlaybackStore } from "../playback/playbackStore";
import { isPlayable } from "../playback/playbackSource";
import { useSettingsStore } from "../store/settingsStore";
import type { Track } from "../types";
import { PauseIcon, PlayIcon } from "./icons";

type Props = {
  track: Track;
};

export function PlayButton({ track }: Props) {
  const currentTrackId = usePlaybackStore((state) => state.currentTrackId);
  const isPlaying = usePlaybackStore((state) => state.isPlaying);
  const toggle = usePlaybackStore((state) => state.toggle);
  const sdkPreferred = useSettingsStore(
    (state) => state.settings.preferFullPlayback,
  );

  const playable = isPlayable(track, sdkPreferred);
  const isCurrent = currentTrackId === track.id;
  const showPause = isCurrent && isPlaying;

  if (!playable) {
    return (
      <button
        type="button"
        disabled
        aria-label="No preview available"
        title="No preview available"
        className="inline-flex w-6 cursor-not-allowed items-center justify-center bg-transparent text-matched opacity-25"
      >
        <PlayIcon />
      </button>
    );
  }

  const label = showPause ? "Pause" : "Play";
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={() => toggle(track.id)}
      className="inline-flex w-6 items-center justify-center bg-transparent text-matched transition-opacity hover:opacity-80"
    >
      {showPause ? <PauseIcon /> : <PlayIcon />}
    </button>
  );
}
