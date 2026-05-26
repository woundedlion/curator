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
  type SpotifyPlayerInstance,
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

type PlaybackState = {
  audio: HTMLAudioElement | null;
  currentTrackId: string | null;
  currentSource: PlaybackSource;
  isPlaying: boolean;
  sdk: SdkState;

  initialize: () => void;
  toggle: (trackId: string) => void;
  playCandidate: (candidate: SpotifyCandidate) => void;
  stop: () => void;
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

function attachAudioEvents(
  audio: HTMLAudioElement,
  set: (patch: Partial<PlaybackState>) => void,
) {
  audio.addEventListener("play", () => set({ isPlaying: true }));
  audio.addEventListener("pause", () => set({ isPlaying: false }));
  audio.addEventListener("ended", () => set({ isPlaying: false }));
  audio.addEventListener("error", () => {
    reportPlaybackFailure(describeMediaError(audio));
    set({
      isPlaying: false,
      currentTrackId: null,
      currentSource: { kind: "none" },
    });
  });
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
    if (error instanceof DOMException && error.name === "AbortError") return;
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
  isPlaying: false,
  sdk: { status: "off" },

  initialize() {
    if (get().audio) return;
    const audio = new Audio();
    audio.preload = "metadata";
    attachAudioEvents(audio, (patch) => set(patch));
    set({ audio });
  },

  async toggle(trackId) {
    const state = get();
    if (!state.audio) return;

    if (state.currentTrackId === trackId) {
      await togglePause(state);
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

    releasePlaybackSource(state.currentSource);
    set({ currentTrackId: trackId, currentSource: nextSource });

    if (nextSource.kind === "spotify-sdk" && sdkState.status === "ready") {
      await playOnSdk(nextSource.uri, sdkState, (patch) => set(patch));
      return;
    }
    void loadAndPlayAudio(state.audio, nextSource);
  },

  async playCandidate(candidate) {
    const state = get();
    if (!state.audio) return;

    const playbackId = candidatePlaybackId(candidate.uri);
    if (state.currentTrackId === playbackId) {
      await togglePause(state);
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

    releasePlaybackSource(state.currentSource);
    set({ currentTrackId: playbackId, currentSource: nextSource });

    if (nextSource.kind === "spotify-sdk" && sdkState.status === "ready") {
      await playOnSdk(nextSource.uri, sdkState, (patch) => set(patch));
      return;
    }
    void loadAndPlayAudio(state.audio, nextSource);
  },

  stop() {
    const state = get();
    if (!state.audio) return;
    state.audio.pause();
    state.audio.removeAttribute("src");
    state.audio.load();
    if (state.sdk.status === "ready") {
      void pauseSpotifyPlayback(state.sdk.player).catch(() => undefined);
    }
    releasePlaybackSource(state.currentSource);
    set({
      currentTrackId: null,
      currentSource: { kind: "none" },
      isPlaying: false,
    });
  },
}));

async function togglePause(state: PlaybackState): Promise<void> {
  if (!state.audio) return;
  if (state.currentSource.kind === "spotify-sdk" && isSdkEnabled(state)) {
    if (state.sdk.status !== "ready") return;
    if (state.isPlaying) {
      await pauseSpotifyPlayback(state.sdk.player).catch(() => undefined);
      usePlaybackStore.setState({ isPlaying: false });
    } else {
      await resumeSpotifyPlayback(state.sdk.player).catch(() => undefined);
      usePlaybackStore.setState({ isPlaying: true });
    }
    return;
  }
  if (state.audio.paused) {
    void state.audio.play().catch((error) => {
      const detail = error instanceof Error ? error.message : String(error);
      reportPlaybackFailure(detail);
    });
  } else {
    state.audio.pause();
  }
}

async function playOnSdk(
  uri: string,
  sdk: SdkState,
  set: (patch: Partial<PlaybackState>) => void,
): Promise<void> {
  if (sdk.status !== "ready") return;
  const clientId = useSettingsStore.getState().settings.spotifyClientId;
  if (!clientId) return;
  try {
    await playSpotifyTrackOnDevice(uri, sdk.deviceId, clientId);
    set({ isPlaying: true });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "unknown SDK error";
    reportPlaybackFailure(`Spotify SDK: ${message}`);
  }
}
