import type { Track } from "../types";
import {
  getSpotifyPreviewUrl,
  getSpotifyUri,
} from "../util/trackAccessors";

// A "local" source carries the File itself, NOT a pre-allocated object
// URL. The blob URL is created lazily inside HtmlAudioBackend.load — at
// the moment it's actually consumed — and the backend owns its full
// lifecycle (create on load, revoke on stop/dispose/replace). Allocating
// the URL up front in createPlaybackSource forced every Player exit path
// to remember to revoke and leaked the URL whenever a target was built
// but never loaded (e.g. the teardown-races-click window in
// playbackStore.toggle). Carrying the File defers allocation past the
// decision, so an un-loaded source allocates nothing to leak.
export type PlaybackSource =
  | { kind: "local"; file: File; label: string }
  | { kind: "spotify-sdk"; uri: string; label: string }
  | { kind: "spotify-preview"; url: string; label: string }
  | { kind: "none" };

// Whether `createPlaybackSource` will produce a non-`none` source for this
// track. Mirrors that function's branches so callers can pre-check (e.g.
// to decide whether to render an in-app play affordance) without building
// a full source. Round-tripped tracks that have only a Spotify URI (no
// localFile, no previewUrl, no SDK) return `false` here — the external-link
// affordance lives in PlayButton, not in the playback source.
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

// The SDK lifecycle status the store mirrors from the Player's lazy init
// outcome. Defined here so the priority policy that consumes it lives in
// one place (see resolveSdkAvailability).
export type SdkAvailabilityStatus =
  | "off"
  | "loading"
  | "ready"
  | "unavailable";

// The two distinct SDK signals the source-selection policy needs. See
// createPlaybackSource for what each one gates. Bundled so the single
// place that derives them (resolveSdkAvailability) is the only thing that
// has to encode the priority rules — every caller (main-view track,
// picker candidate) funnels through it instead of re-deriving and risking
// drift.
export type SdkAvailability = { sdkReady: boolean; sdkInitable: boolean };

// SINGLE SOURCE OF TRUTH for "is the SDK an option, and how strong a one?"
// Previously the store's isSdkUsable() and the candidate-target builder
// each re-derived this from sdk.status + opt-in, and had to be kept in
// sync by hand (comments literally said they must "mirror" each other).
//   - `sdkReady`: connected RIGHT NOW — only "ready" qualifies.
//   - `sdkInitable`: usable enough to attempt — "ready", OR opted-in and
//     not-yet-failed ("unavailable" closes the SDK for the session).
// `shouldTry` carries the user opt-in + client-id check (the store's
// shouldTryEnableSdk), kept out of this module so it stays settings-free.
export function resolveSdkAvailability(
  status: SdkAvailabilityStatus,
  shouldTry: boolean,
): SdkAvailability {
  const sdkReady = status === "ready";
  const sdkInitable = sdkReady || (status !== "unavailable" && shouldTry);
  return { sdkReady, sdkInitable };
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
      file: track.localFile,
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

// Direct media URL for sources that already carry one (Spotify previews
// are ordinary HTTPS URLs the <audio> element can stream as-is). "local"
// is deliberately absent: its blob URL is created and owned inside
// HtmlAudioBackend.load, never minted here, so there's nothing to return.
export function getAudioElementUrl(source: PlaybackSource): string | null {
  if (source.kind === "spotify-preview") return source.url;
  return null;
}
