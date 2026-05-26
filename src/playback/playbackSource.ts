import type { Track } from "../types";

export type PlaybackSource =
  | { kind: "local"; objectUrl: string; label: string }
  | { kind: "spotify-sdk"; uri: string; label: string }
  | { kind: "spotify-preview"; url: string; label: string }
  | { kind: "none" };

export function isPlayable(
  track: Track,
  sdkEnabled: boolean,
): boolean {
  if (track.localFile) return true;
  if (sdkEnabled && track.spotify.uri) return true;
  if (track.spotify.previewUrl) return true;
  return false;
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
  if (sdkEnabled && track.spotify.uri) {
    return {
      kind: "spotify-sdk",
      uri: track.spotify.uri,
      label: "Spotify (full track)",
    };
  }
  if (track.spotify.previewUrl) {
    return {
      kind: "spotify-preview",
      url: track.spotify.previewUrl,
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
