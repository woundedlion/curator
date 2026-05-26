import { usePlaybackStore } from "../playback/playbackStore";
import { externalSpotifyUrl, isPlayable } from "../playback/playbackSource";
import { useSettingsStore } from "../store/settingsStore";
import type { Track } from "../types";
import { ExternalLinkIcon, PauseIcon, PlayIcon } from "./icons";

type Props = {
  track: Track;
};

// Whether the row can play *in app* right now. When false but a Spotify
// URI exists, the button instead opens the Spotify track page (matching
// the picker dialog's preview→SDK→external-link fallback chain).
function hasInAppPlayback(track: Track, sdkPreferred: boolean): boolean {
  if (track.localFile) return true;
  if (sdkPreferred && track.spotify.uri) return true;
  if (track.spotify.previewUrl) return true;
  return false;
}

export function PlayButton({ track }: Props) {
  const currentTrackId = usePlaybackStore((state) => state.currentTrackId);
  const isPlaying = usePlaybackStore((state) => state.isPlaying);
  const toggle = usePlaybackStore((state) => state.toggle);
  const sdkPreferred = useSettingsStore(
    (state) => state.settings.preferFullPlayback,
  );

  const playable = isPlayable(track, sdkPreferred);
  const inApp = hasInAppPlayback(track, sdkPreferred);
  const externalUrl =
    !inApp && track.spotify.uri ? externalSpotifyUrl(track.spotify.uri) : null;
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

  if (externalUrl) {
    return (
      <a
        href={externalUrl}
        target="_blank"
        rel="noopener noreferrer"
        aria-label="Open in Spotify"
        title="Open in Spotify (no in-app preview available)"
        className="inline-flex w-6 items-center justify-center bg-transparent text-matched transition-opacity hover:opacity-80"
      >
        <ExternalLinkIcon />
      </a>
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
