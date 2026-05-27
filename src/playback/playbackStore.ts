import { create } from "zustand";
import type { SpotifyCandidate } from "../types";
import { usePlaylistStore } from "../store/playlistStore";
import { useSettingsStore } from "../store/settingsStore";
import { useUiStore } from "../store/uiStore";
import {
  initializeSpotifyPlayer,
  pauseSpotifyPlayback,
  playSpotifyTrackOnDevice,
  resumeSpotifyPlayback,
  seekSpotifyPlayback,
  type SpotifyPlayerInstance,
  type SpotifyPlayerListener,
  type SpotifyPlayerSdkState,
} from "../spotify/spotifyPlayer";
import {
  createPlaybackSource,
  getAudioElementUrl,
  releasePlaybackSource,
  type PlaybackSource,
} from "./playbackSource";

export function candidatePlaybackId(uri: string): string {
  return `candidate:${uri}`;
}

type SdkState =
  | { status: "off" }
  | { status: "loading" }
  | {
      status: "ready";
      deviceId: string;
      player: SpotifyPlayerInstance;
    }
  | { status: "unavailable"; reason: string };

// Title/artist for the now-playing UI. Set for both regular track playback
// (mirrors the Track's fields) and dialog candidate playback (mirrors the
// candidate's fields). Without this the NowPlayingBar could only resolve
// playback via `tracksById[currentTrackId]`, which is null for the
// synthetic `candidate:{uri}` ids that AmbiguousMatchDialog uses.
export type PlaybackDisplay = { title: string; artist: string };

type PlaybackState = {
  audio: HTMLAudioElement | null;
  currentTrackId: string | null;
  currentSource: PlaybackSource;
  currentDisplay: PlaybackDisplay | null;
  isPlaying: boolean;
  // Live playhead + duration in ms. For HTMLAudio-backed sources these are
  // driven by `timeupdate` / `loadedmetadata`; for the Spotify SDK they're
  // driven by `player_state_changed` events plus a 500ms poll while playing.
  // Zero when no track is loaded.
  positionMs: number;
  durationMs: number;
  sdk: SdkState;

  initialize: () => void;
  toggle: (trackId: string) => void;
  playCandidate: (candidate: SpotifyCandidate) => void;
  stop: () => void;
  seek: (positionMs: number) => void;
};

function reportPlaybackFailure(detail: string): void {
  console.error("Playback failed", detail);
  useUiStore.getState().pushToast({
    kind: "error",
    message: `Playback failed: ${detail}`,
  });
}

function describeMediaError(audio: HTMLAudioElement): string {
  const error = audio.error;
  if (!error) return "unknown media error";
  switch (error.code) {
    case error.MEDIA_ERR_ABORTED:
      return "playback aborted";
    case error.MEDIA_ERR_NETWORK:
      return "network error while loading audio";
    case error.MEDIA_ERR_DECODE:
      return "audio decode error";
    case error.MEDIA_ERR_SRC_NOT_SUPPORTED:
      return "audio format not supported by this browser";
    default:
      return `media error ${error.code}`;
  }
}

function audioDurationMs(audio: HTMLAudioElement): number {
  // `audio.duration` is NaN before metadata loads and Infinity for some live
  // streams; clamp those to 0 so the slider stays disabled rather than
  // showing a garbage range.
  const d = audio.duration;
  if (!Number.isFinite(d) || d <= 0) return 0;
  return Math.floor(d * 1000);
}

function audioPositionMs(audio: HTMLAudioElement): number {
  const t = audio.currentTime;
  if (!Number.isFinite(t) || t < 0) return 0;
  return Math.floor(t * 1000);
}

function attachAudioEvents(
  audio: HTMLAudioElement,
  set: (patch: Partial<PlaybackState>) => void,
) {
  audio.addEventListener("play", () => set({ isPlaying: true }));
  audio.addEventListener("pause", () => set({ isPlaying: false }));
  audio.addEventListener("ended", () =>
    set({ isPlaying: false, positionMs: 0 }),
  );
  audio.addEventListener("timeupdate", () =>
    set({ positionMs: audioPositionMs(audio) }),
  );
  audio.addEventListener("loadedmetadata", () =>
    set({ durationMs: audioDurationMs(audio) }),
  );
  audio.addEventListener("durationchange", () =>
    set({ durationMs: audioDurationMs(audio) }),
  );
  audio.addEventListener("seeked", () =>
    set({ positionMs: audioPositionMs(audio) }),
  );
  audio.addEventListener("error", () => {
    // Don't surface a "playback failed" toast when stop() yanked the src
    // — the error event in that case is a side effect of our own teardown.
    if (stopRequested) return;
    reportPlaybackFailure(describeMediaError(audio));
    set({
      isPlaying: false,
      currentTrackId: null,
      currentSource: { kind: "none" },
      currentDisplay: null,
      positionMs: 0,
      durationMs: 0,
    });
  });
}

// ─── Spotify SDK progress tracking ───────────────────────────────────────
// The SDK fires `player_state_changed` only on transitions (play/pause/track
// change), so a smooth progress bar needs a low-rate poll on top. Both are
// owned at module scope (single global SDK player + single now-playing UI),
// matched up by setup/teardown so we don't leak intervals or listeners.

const SDK_POLL_INTERVAL_MS = 500;
let sdkPoller: ReturnType<typeof setInterval> | null = null;
let sdkStateListener: SpotifyPlayerListener | null = null;
let sdkTrackedPlayer: SpotifyPlayerInstance | null = null;

// Single-flight guard around toggle() / playCandidate(). Both can await
// tryInitSdk() for up to ~10s; without this guard a second click during
// init would race the first and break the "only one track at a time"
// invariant by mutating shared playback state in parallel. Errors are
// caught so one failure does not poison the chain.
let playbackOperation: Promise<void> = Promise.resolve();

function queuePlaybackOperation(fn: () => Promise<void>): Promise<void> {
  const next = playbackOperation.then(fn, fn);
  playbackOperation = next.catch(() => undefined);
  return next;
}

// Set true while stop() is actively yanking the audio element's src. The
// resulting `error` event from audio.load() is not a real user-facing
// failure — gating the toast on this flag prevents the spurious "audio
// format not supported" message on every explicit stop.
let stopRequested = false;

export function isExplicitStopInProgress(): boolean {
  return stopRequested;
}

async function doPlayCandidate(
  candidate: SpotifyCandidate,
  get: () => PlaybackState,
  set: (patch: Partial<PlaybackState>) => void,
): Promise<void> {
  const state = get();
  if (!state.audio) return;

  const playbackId = candidatePlaybackId(candidate.uri);
  if (state.currentTrackId === playbackId) {
    await togglePause(state, (patch) => set(patch));
    return;
  }

  let sdkState = state.sdk;
  if (
    !candidate.previewUrl &&
    shouldTryEnableSdk() &&
    sdkState.status === "off"
  ) {
    sdkState = await tryInitSdk((patch) => set(patch));
  }
  const sdkReady = sdkState.status === "ready";

  let nextSource: PlaybackSource;
  if (candidate.previewUrl) {
    nextSource = {
      kind: "spotify-preview",
      url: candidate.previewUrl,
      label: "Spotify preview (30s)",
    };
  } else if (sdkReady) {
    nextSource = {
      kind: "spotify-sdk",
      uri: candidate.uri,
      label: "Spotify (full track)",
    };
  } else {
    return;
  }

  const display: PlaybackDisplay = trackDisplay({
    title: candidate.title,
    artist: candidate.artist,
  });
  if (nextSource.kind === "spotify-sdk" && sdkState.status === "ready") {
    const ok = await playOnSdk(nextSource.uri, sdkState, (patch) => set(patch));
    if (!ok) return;
    releasePlaybackSource(state.currentSource);
    set({
      currentTrackId: playbackId,
      currentSource: nextSource,
      currentDisplay: display,
      positionMs: 0,
      durationMs: candidate.durationMs ?? 0,
    });
    startSdkProgressTracking(sdkState.player, (patch) => set(patch));
    return;
  }

  stopSdkProgressTracking();
  releasePlaybackSource(state.currentSource);
  set({
    currentTrackId: playbackId,
    currentSource: nextSource,
    currentDisplay: display,
    positionMs: 0,
    durationMs: candidate.durationMs ?? 0,
  });
  await loadAndPlayAudio(state.audio, nextSource);
}

function startSdkProgressTracking(
  player: SpotifyPlayerInstance,
  set: (patch: Partial<PlaybackState>) => void,
): void {
  stopSdkProgressTracking();
  sdkTrackedPlayer = player;

  function applyState(state: SpotifyPlayerSdkState | null): void {
    if (!state) return;
    set({
      isPlaying: !state.paused,
      positionMs: state.position,
      durationMs: state.duration,
    });
  }

  const listener: SpotifyPlayerListener = (data) => {
    applyState(data as SpotifyPlayerSdkState | null);
  };
  player.addListener("player_state_changed", listener);
  sdkStateListener = listener;

  sdkPoller = setInterval(() => {
    void player
      .getCurrentState()
      .then(applyState)
      .catch(() => {
        // getCurrentState rejects when the device is no longer active. Don't
        // spam the console — the listener will fire if state actually changes.
      });
  }, SDK_POLL_INTERVAL_MS);
}

function stopSdkProgressTracking(): void {
  if (sdkPoller !== null) {
    clearInterval(sdkPoller);
    sdkPoller = null;
  }
  if (sdkTrackedPlayer && sdkStateListener) {
    sdkTrackedPlayer.removeListener("player_state_changed", sdkStateListener);
  }
  sdkStateListener = null;
  sdkTrackedPlayer = null;
}

function trackDisplay(track: { title?: string; artist?: string }): PlaybackDisplay {
  return {
    title: track.title ?? "Unknown title",
    artist: track.artist ?? "Unknown artist",
  };
}

async function loadAndPlayAudio(
  audio: HTMLAudioElement,
  source: PlaybackSource,
): Promise<void> {
  const url = getAudioElementUrl(source);
  if (!url) return;
  audio.src = url;
  try {
    await audio.play();
  } catch (error) {
    if (error instanceof DOMException) {
      // AbortError: another play() superseded this one — fine.
      if (error.name === "AbortError") return;
      // NotAllowedError: browser autoplay policy blocked us. The blocker
      // is the user-gesture model, not the file. Surface a specific
      // message instead of a generic "playback failed: NotAllowedError."
      if (error.name === "NotAllowedError") {
        reportPlaybackFailure(
          "browser blocked autoplay — click play again to allow audio",
        );
        return;
      }
    }
    const detail = error instanceof Error ? error.message : String(error);
    reportPlaybackFailure(detail);
  }
}

function isSdkEnabled(state: PlaybackState): boolean {
  return state.sdk.status === "ready";
}

function shouldTryEnableSdk(): boolean {
  const settings = useSettingsStore.getState().settings;
  return Boolean(settings.preferFullPlayback && settings.spotifyClientId);
}

async function tryInitSdk(
  set: (patch: Partial<PlaybackState>) => void,
): Promise<SdkState> {
  const clientId = useSettingsStore.getState().settings.spotifyClientId;
  if (!clientId) return { status: "off" };
  set({ sdk: { status: "loading" } });
  const result = await initializeSpotifyPlayer(clientId);
  if (result.ok) {
    const ready: SdkState = {
      status: "ready",
      deviceId: result.deviceId,
      player: result.player,
    };
    set({ sdk: ready });
    return ready;
  }
  const unavailable: SdkState = { status: "unavailable", reason: result.message };
  set({ sdk: unavailable });
  useUiStore.getState().pushToast({
    kind: "error",
    message:
      result.reason === "not-premium"
        ? "Spotify Premium required for full-track playback — falling back to 30-second previews"
        : `Spotify SDK unavailable (${result.message}) — falling back to previews`,
  });
  return unavailable;
}

export const usePlaybackStore = create<PlaybackState>((set, get) => ({
  audio: null,
  currentTrackId: null,
  currentSource: { kind: "none" },
  currentDisplay: null,
  isPlaying: false,
  positionMs: 0,
  durationMs: 0,
  sdk: { status: "off" },

  initialize() {
    if (get().audio) return;
    const audio = new Audio();
    audio.preload = "metadata";
    attachAudioEvents(audio, (patch) => set(patch));
    set({ audio });
  },

  toggle(trackId) {
    void queuePlaybackOperation(async () => {
      // Re-read state inside the queued task — by the time we run, prior
      // ops may have changed currentTrackId / sdk / etc.
      const state = get();
      if (!state.audio) return;

      if (state.currentTrackId === trackId) {
        await togglePause(state, (patch) => set(patch));
        return;
      }

      const track = usePlaylistStore.getState().tracksById[trackId];
      if (!track) return;

      let sdkState = state.sdk;
      if (shouldTryEnableSdk() && sdkState.status === "off") {
        sdkState = await tryInitSdk((patch) => set(patch));
      }
      const sdkReady = sdkState.status === "ready";

      const nextSource = createPlaybackSource(track, sdkReady);
      if (nextSource.kind === "none") return;

      if (nextSource.kind === "spotify-sdk" && sdkState.status === "ready") {
        const ok = await playOnSdk(nextSource.uri, sdkState, (patch) => set(patch));
        if (!ok) return;
        releasePlaybackSource(state.currentSource);
        // Seed duration from the track's known length so the slider has a
        // sensible range before the SDK reports its own state.
        set({
          currentTrackId: trackId,
          currentSource: nextSource,
          currentDisplay: trackDisplay(track),
          positionMs: 0,
          durationMs: track.durationMs ?? 0,
        });
        startSdkProgressTracking(sdkState.player, (patch) => set(patch));
        return;
      }

      stopSdkProgressTracking();
      releasePlaybackSource(state.currentSource);
      set({
        currentTrackId: trackId,
        currentSource: nextSource,
        currentDisplay: trackDisplay(track),
        positionMs: 0,
        durationMs: track.durationMs ?? 0,
      });
      await loadAndPlayAudio(state.audio, nextSource);
    });
  },

  playCandidate(candidate) {
    void queuePlaybackOperation(() => doPlayCandidate(candidate, get, set));
  },

  stop() {
    void queuePlaybackOperation(async () => {
      const state = get();
      if (!state.audio) return;
      // Mark explicit-stop so the audio element's `error` event (which can
      // fire when we yank the src below) doesn't surface as a user-facing
      // toast claiming "audio format not supported."
      stopRequested = true;
      try {
        state.audio.pause();
        state.audio.removeAttribute("src");
        state.audio.load();
      } finally {
        // Release the flag on the next tick — the error event from `load()`
        // dispatches synchronously into the queue, so by the time another
        // task runs we're done.
        setTimeout(() => {
          stopRequested = false;
        }, 0);
      }
      if (state.sdk.status === "ready") {
        try {
          await pauseSpotifyPlayback(state.sdk.player);
        } catch (error) {
          console.warn("Spotify SDK pause failed", error);
        }
      }
      stopSdkProgressTracking();
      releasePlaybackSource(state.currentSource);
      set({
        currentTrackId: null,
        currentSource: { kind: "none" },
        currentDisplay: null,
        isPlaying: false,
        positionMs: 0,
        durationMs: 0,
      });
    });
  },

  seek(positionMs) {
    const state = get();
    if (!state.audio) return;
    if (state.currentTrackId === null) return;
    const clamped = Math.max(
      0,
      state.durationMs > 0 ? Math.min(positionMs, state.durationMs) : positionMs,
    );
    if (
      state.currentSource.kind === "spotify-sdk" &&
      state.sdk.status === "ready"
    ) {
      // Optimistically reflect the new playhead so the slider doesn't snap
      // back to the old value before the SDK reports the seeked state.
      set({ positionMs: clamped });
      void seekSpotifyPlayback(state.sdk.player, clamped).catch((error) => {
        console.warn("Spotify SDK seek failed", error);
      });
      return;
    }
    if (
      state.currentSource.kind === "local" ||
      state.currentSource.kind === "spotify-preview"
    ) {
      try {
        state.audio.currentTime = clamped / 1000;
        set({ positionMs: clamped });
      } catch (error) {
        console.warn("audio seek failed", error);
      }
    }
  },
}));

async function togglePause(
  state: PlaybackState,
  set: (patch: Partial<PlaybackState>) => void,
): Promise<void> {
  if (!state.audio) return;
  if (state.currentSource.kind === "spotify-sdk" && isSdkEnabled(state)) {
    if (state.sdk.status !== "ready") return;
    if (state.isPlaying) {
      try {
        await pauseSpotifyPlayback(state.sdk.player);
        set({ isPlaying: false });
      } catch (error) {
        console.warn("Spotify SDK pause failed", error);
      }
    } else {
      try {
        await resumeSpotifyPlayback(state.sdk.player);
        set({ isPlaying: true });
      } catch (error) {
        console.warn("Spotify SDK resume failed", error);
      }
    }
    return;
  }
  if (state.audio.paused) {
    void state.audio.play().catch((error) => {
      if (error instanceof DOMException && error.name === "AbortError") return;
      const detail = error instanceof Error ? error.message : String(error);
      reportPlaybackFailure(detail);
    });
  } else {
    state.audio.pause();
  }
}

// Returns true if the SDK accepted the play command; on failure, leaves
// playback state untouched so callers don't paint a stale "now playing" row.
async function playOnSdk(
  uri: string,
  sdk: SdkState,
  set: (patch: Partial<PlaybackState>) => void,
): Promise<boolean> {
  if (sdk.status !== "ready") return false;
  const clientId = useSettingsStore.getState().settings.spotifyClientId;
  if (!clientId) return false;
  try {
    await playSpotifyTrackOnDevice(uri, sdk.deviceId, clientId);
    set({ isPlaying: true });
    return true;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "unknown SDK error";
    reportPlaybackFailure(`Spotify SDK: ${message}`);
    return false;
  }
}
