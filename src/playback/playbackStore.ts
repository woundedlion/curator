// Thin Zustand adapter over the Player abstraction. The store's job is
// twofold:
//
//   1. Mirror the Player's snapshot into Zustand-reactive fields the
//      UI subscribes to (currentTrackId, isPlaying, positionMs, etc.).
//   2. Translate UI inputs (a Track + sdk status, a SpotifyCandidate)
//      into PlayerTarget values, then hand them to the Player.
//
// Every invariant about *what plays when* lives in Player. The store
// does no playback state itself; it can't accidentally desync from the
// backends because it never talks to them.

import { create } from "zustand";
import type { SpotifyCandidate } from "../types";
import { usePlaylistStore } from "../store/playlistStore";
import { useSettingsStore } from "../store/settingsStore";
import { useUiStore } from "../store/uiStore";
import {
  initializeSpotifyPlayer,
  type SpotifyPlayerHandlers,
} from "../spotify/spotifyPlayer";
import { HtmlAudioBackend } from "./htmlAudioBackend";
import {
  Player,
  type Backend,
  type PlayerSnapshot,
  type PlayerTarget,
} from "./player";
import { createPlaybackSource, type PlaybackSource } from "./playbackSource";
import { SpotifySdkBackend } from "./spotifySdkBackend";

export function candidatePlaybackId(uri: string): string {
  return `candidate:${uri}`;
}

type SdkStatus =
  | { status: "off" }
  | { status: "loading" }
  | { status: "ready" }
  | { status: "unavailable"; reason: string };

type PlaybackState = {
  // ─── Snapshot mirror ──────────────────────────────────────────────
  currentTrackId: string | null;
  currentSource: PlaybackSource;
  currentDisplay: { title: string; artist: string } | null;
  isPlaying: boolean;
  positionMs: number;
  durationMs: number;

  // ─── SDK availability mirror (separate from the Player) ──────────
  // The dialog reads this to decide whether SDK playback is an option
  // for a candidate without a previewUrl. Mirrors the Player's lazy
  // SDK init outcome — "off" until first attempt, "ready" or
  // "unavailable" after.
  sdk: SdkStatus;

  // ─── Actions ──────────────────────────────────────────────────────
  initialize: () => void;
  toggle: (trackId: string) => void;
  playCandidate: (candidate: SpotifyCandidate) => void;
  stop: () => void;
  /**
   * Stop only if the currently-playing target is a candidate (picker
   * preview). The picker calls this on unmount so closing the dialog
   * cleans up its own playback without stopping main-view audio.
   */
  stopIfCandidate: () => void;
  seek: (positionMs: number) => void;
};

function snapshotToState(snap: PlayerSnapshot): Partial<PlaybackState> {
  return {
    currentTrackId: snap.currentTrackId,
    currentSource: snap.target?.source ?? { kind: "none" },
    currentDisplay: snap.target?.display ?? null,
    isPlaying: snap.isPlaying,
    positionMs: snap.positionMs,
    durationMs: snap.durationMs,
  };
}

function trackDisplay(track: { title?: string; artist?: string }): {
  title: string;
  artist: string;
} {
  return {
    title: track.title ?? "Unknown title",
    artist: track.artist ?? "Unknown artist",
  };
}

function shouldTryEnableSdk(): boolean {
  const settings = useSettingsStore.getState().settings;
  return Boolean(settings.preferFullPlayback && settings.spotifyClientId);
}

// Module-scoped wrapper so the test reset helper can swap its `.player`
// field. The wrapper object itself is never reassigned — actions
// dereference `storeRef.player` lazily.
const storeRef: { player: Player | null } = { player: null };

export const usePlaybackStore = create<PlaybackState>((set, get) => {

  async function loadSdk(): Promise<Backend | null> {
    const clientId = useSettingsStore.getState().settings.spotifyClientId;
    if (!clientId) {
      // Reachable only if the Client ID was cleared between the
      // shouldTryEnableSdk() check at build-target time and the loader
      // firing inside Player.install(). Without a toast the user would
      // see nothing happen.
      set({ sdk: { status: "unavailable", reason: "no client id" } });
      useUiStore.getState().pushToast({
        kind: "error",
        message: "Spotify Client ID not configured — set it in Settings to enable full-track playback",
      });
      return null;
    }
    set({ sdk: { status: "loading" } });
    // Post-init SDK event handlers wired through the init call so the
    // SDK's `playback_error` / `not_ready` listeners route to us from
    // the moment they could fire. `playback_error`: DRM hiccup, decode
    // failure, network drop mid-track. `not_ready`: device dropped out
    // (sleep, tab took over the device). Both demand user-visible
    // feedback and SDK teardown so the next play doesn't issue commands
    // against a dead device id.
    const handlers: SpotifyPlayerHandlers = {
      onError: (message) => {
        useUiStore.getState().pushToast({
          kind: "error",
          message: `Spotify playback error: ${message}`,
        });
      },
      onNotReady: () => {
        // Mark unavailable so candidate/track target construction
        // stops feeding the SDK path until a reload. Stop any
        // in-flight playback so the now-playing bar doesn't pin to
        // silent audio.
        set({
          sdk: {
            status: "unavailable",
            reason: "device dropped out",
          },
        });
        void storeRef.player?.stop();
        useUiStore.getState().pushToast({
          kind: "error",
          message:
            "Spotify playback device disconnected — falling back to 30-second previews this session (reload to retry)",
        });
      },
    };
    const result = await initializeSpotifyPlayer(clientId, handlers);
    if (result.ok) {
      const backend = new SpotifySdkBackend({
        player: result.player,
        deviceId: result.deviceId,
        clientId,
      });
      set({ sdk: { status: "ready" } });
      return backend;
    }
    set({ sdk: { status: "unavailable", reason: result.message } });
    useUiStore.getState().pushToast({
      kind: "error",
      message:
        result.reason === "not-premium"
          ? "Spotify Premium required for full-track playback — falling back to 30-second previews"
          : `Spotify SDK unavailable (${result.message}) — falling back to previews`,
    });
    return null;
  }

  function buildTrackTarget(trackId: string): PlayerTarget | null {
    const track = usePlaylistStore.getState().tracksById[trackId];
    if (!track) return null;
    const sdkReady = get().sdk.status === "ready";
    const source = createPlaybackSource(track, sdkReady);
    if (source.kind === "none") return null;
    return {
      kind: "track",
      id: trackId,
      display: trackDisplay(track),
      durationMs: track.durationMs ?? 0,
      source,
    };
  }

  function buildCandidateTarget(
    candidate: SpotifyCandidate,
  ): PlayerTarget | null {
    // previewUrl is always preferred when present — it works without
    // SDK and without Premium. Falling back to SDK is only viable when
    // the user opted in AND has a client id AND SDK init hasn't
    // already failed. Once status is "unavailable" the Player caches
    // sdkLoadAttempted=true and silently returns null on every
    // subsequent SDK-required install; constructing an SDK source here
    // would produce a silent dead-end (no playback, no toast). Treat
    // "unavailable" as "SDK is closed for the rest of this session"
    // and fall through to the no-source toast in playCandidate.
    const sdkStatus = get().sdk.status;
    const sdkUsable =
      sdkStatus === "ready" ||
      (sdkStatus !== "unavailable" && shouldTryEnableSdk());
    const source: PlaybackSource = candidate.previewUrl
      ? {
          kind: "spotify-preview",
          url: candidate.previewUrl,
          label: "Spotify preview (30s)",
        }
      : sdkUsable
        ? {
            kind: "spotify-sdk",
            uri: candidate.uri,
            label: "Spotify (full track)",
          }
        : { kind: "none" };
    if (source.kind === "none") return null;
    return {
      kind: "candidate",
      id: candidatePlaybackId(candidate.uri),
      display: { title: candidate.title, artist: candidate.artist },
      durationMs: candidate.durationMs ?? 0,
      source,
    };
  }

  return {
    currentTrackId: null,
    currentSource: { kind: "none" },
    currentDisplay: null,
    isPlaying: false,
    positionMs: 0,
    durationMs: 0,
    sdk: { status: "off" },

    initialize() {
      if (storeRef.player) return;
      const audio = new Audio();
      const htmlBackend = new HtmlAudioBackend(audio);
      const p = new Player({
        htmlBackend,
        sdkLoader: loadSdk,
        onError: (message) => {
          useUiStore.getState().pushToast({
            kind: "error",
            message: `Playback failed: ${message}`,
          });
        },
      });
      p.subscribe((snap) => set(snapshotToState(snap)));
      storeRef.player = p;
    },

    toggle(trackId) {
      if (!storeRef.player) return;
      const target = buildTrackTarget(trackId);
      if (!target) return;
      void storeRef.player.play(target);
    },

    playCandidate(candidate) {
      if (!storeRef.player) return;
      const target = buildCandidateTarget(candidate);
      if (!target) {
        const sdkStatus = get().sdk.status;
        const sdkUnavailable = sdkStatus === "unavailable";
        const sdkOff = !shouldTryEnableSdk() && sdkStatus !== "ready";
        let message: string;
        if (!candidate.previewUrl && sdkUnavailable) {
          message =
            "No 30-second preview for this track — full-track playback is unavailable this session (reload to retry)";
        } else if (!candidate.previewUrl && sdkOff) {
          message =
            "No 30-second preview for this track — enable Full-track playback in Settings (requires Spotify Premium)";
        } else {
          message = "Playback unavailable for this track";
        }
        useUiStore.getState().pushToast({ kind: "info", message });
        return;
      }
      void storeRef.player.play(target);
    },

    stop() {
      void storeRef.player?.stop();
    },

    stopIfCandidate() {
      void storeRef.player?.stopIfCandidate();
    },

    seek(positionMs) {
      void storeRef.player?.seek(positionMs);
    },
  };
});

// ─── Test-only seam ──────────────────────────────────────────────────
//
// Tests need a way to reset the module-level Player + Zustand store
// between cases. Exposing this from the store module (vs. the Player)
// is intentional — the Player itself is internal to the module after
// initialize() runs, and tests want the store interface.
export function __resetPlaybackStoreForTests(): void {
  // Discard the Player instance so the next initialize() builds a
  // fresh one. Without this, the Player's internal snapshot leaks
  // across tests and produces baffling "play does the opposite"
  // failures on the second test in a file.
  storeRef.player = null;
  usePlaybackStore.setState({
    currentTrackId: null,
    currentSource: { kind: "none" },
    currentDisplay: null,
    isPlaying: false,
    positionMs: 0,
    durationMs: 0,
    sdk: { status: "off" },
  });
}
