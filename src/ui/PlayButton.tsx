import { usePlaybackStore } from "../playback/playbackStore";
import { externalSpotifyUrl, hasInAppSource } from "../playback/playbackSource";
import { useSettingsStore } from "../store/settingsStore";
import type { Track } from "../types";
import { getSpotifyUri } from "../util/trackAccessors";
import { ExternalLinkIcon, PauseIcon, PlayIcon } from "./icons";

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

  // Three states: in-app play (the toggle path), external-link fallback
  // (Spotify URI but no in-app source — round-tripped imports), or fully
  // disabled.
  const inApp = hasInAppSource(track, sdkPreferred);
  const spotifyUri = getSpotifyUri(track.spotify);
  const externalUrl =
    !inApp && spotifyUri ? externalSpotifyUrl(spotifyUri) : null;
  const isCurrent = currentTrackId === track.id;
  const showPause = isCurrent && isPlaying;

  if (!inApp && !externalUrl) {
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
