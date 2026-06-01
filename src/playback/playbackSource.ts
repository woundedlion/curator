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

// Source selection policy. Two SDK signals, deliberately distinct:
//   - `sdkReady`: the SDK device is connected RIGHT NOW. Only then do we
//     prefer full-track Spotify over the local file for a resolved match
//     (issue 1) — we never trade working local/preview audio for an SDK
//     source that might be seconds away or might fail to connect at all.
//   - `sdkInitable`: the user opted in and init hasn't failed this session,
//     but it isn't connected yet. This only earns the SDK the LAST-RESORT
//     slot — used to kick off lazy init for a Spotify-only track that has
//     no local file and no preview (issue 3: the old "connecting… try
//     again" dead-end). It must NOT outrank a local file or a preview,
//     which both play immediately and don't depend on Premium.
export function createPlaybackSource(
  track: Track,
  sdkReady: boolean,
  sdkInitable: boolean,
): PlaybackSource {
  const uri = getSpotifyUri(track.spotify);
  // Issue 1: a resolved match prefers full-track Spotify over the local
  // file — but only when the SDK is actually connected.
  if (track.spotify.status === "matched" && sdkReady && uri) {
    return {
      kind: "spotify-sdk",
      uri,
      label: "Spotify (full track)",
    };
  }
  if (track.localFile) {
    return {
      kind: "local",
      objectUrl: URL.createObjectURL(track.localFile),
      label: "Local file",
    };
  }
  // A 30-second preview plays immediately and without Premium — prefer it
  // over an un-connected (initable) SDK so a non-Premium user still hears
  // audio. A connected SDK already won above for matched rows.
  const previewUrl = getSpotifyPreviewUrl(track.spotify);
  if (previewUrl) {
    return {
      kind: "spotify-preview",
      url: previewUrl,
      label: "Spotify preview (30s)",
    };
  }
  // Last resort: full-track SDK for a Spotify-only, preview-less row. When
  // not yet connected, `sdkInitable` still emits the source so the first
  // play lazily kicks off SDK init via Player.resolveBackend (issue 3).
  if ((sdkReady || sdkInitable) && uri) {
    return {
      kind: "spotify-sdk",
      uri,
      label: "Spotify (full track)",
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
