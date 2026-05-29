import type { Track } from "../types";
import {
  getSpotifyPreviewUrl,
  getSpotifyUri,
} from "../util/trackAccessors";

export type PlaybackSource =
  | { kind: "local"; objectUrl: string; label: string }
  | { kind: "spotify-sdk"; uri: string; label: string }
  | { kind: "spotify-preview"; url: string; label: string }
  | { kind: "none" };

// Whether `createPlaybackSource` will produce a non-`none` source for this
// track. Mirrors that function's branches so callers can pre-check without
// allocating an objectUrl. Round-tripped tracks that have only a Spotify
// URI (no localFile, no previewUrl, no SDK) return `false` here — the
// external-link affordance lives in PlayButton, not in the playback source.
export function hasInAppSource(
  track: Track,
  sdkEnabled: boolean,
): boolean {
  if (track.localFile) return true;
  if (sdkEnabled && getSpotifyUri(track.spotify)) return true;
  if (getSpotifyPreviewUrl(track.spotify)) return true;
  return false;
}

// Parses `spotify:track:abc123` → `https://open.spotify.com/track/abc123`.
// Used as the play fallback when no in-app source is available.
export function externalSpotifyUrl(spotifyUri: string): string | null {
  const prefix = "spotify:track:";
  if (!spotifyUri.startsWith(prefix)) return null;
  const id = spotifyUri.slice(prefix.length);
  if (!id) return null;
  return `https://open.spotify.com/track/${id}`;
}

export function createPlaybackSource(
  track: Track,
  sdkEnabled: boolean,
): PlaybackSource {
  if (track.localFile) {
    return {
      kind: "local",
      objectUrl: URL.createObjectURL(track.localFile),
      label: "Local file",
    };
  }
  const uri = getSpotifyUri(track.spotify);
  if (sdkEnabled && uri) {
    return {
      kind: "spotify-sdk",
      uri,
      label: "Spotify (full track)",
    };
  }
  const previewUrl = getSpotifyPreviewUrl(track.spotify);
  if (previewUrl) {
    return {
      kind: "spotify-preview",
      url: previewUrl,
      label: "Spotify preview (30s)",
    };
  }
  return { kind: "none" };
}

export function releasePlaybackSource(source: PlaybackSource): void {
  if (source.kind === "local") URL.revokeObjectURL(source.objectUrl);
}

export function getAudioElementUrl(source: PlaybackSource): string | null {
  if (source.kind === "local") return source.objectUrl;
  if (source.kind === "spotify-preview") return source.url;
  return null;
}
