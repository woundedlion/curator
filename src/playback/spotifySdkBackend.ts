// Backend that wraps the Spotify Web Playback SDK player. Translates
// the SDK's event API + state polling into the Player's BackendEvent
// stream. One instance per Player; the SDK player itself is a singleton
// owned by src/spotify/spotifyPlayer.ts.

import {
  pauseSpotifyPlayback,
  playSpotifyTrackOnDevice,
  resumeSpotifyPlayback,
  seekSpotifyPlayback,
  type SpotifyPlayerInstance,
  type SpotifyPlayerListener,
  type SpotifyPlayerSdkState,
} from "../spotify/spotifyPlayer";
import type { Backend, BackendObserver } from "./player";
import type { PlaybackSource } from "./playbackSource";

const POLL_INTERVAL_MS = 500;

export class SpotifySdkBackend implements Backend {
  readonly kind = "spotify-sdk" as const;
  private player: SpotifyPlayerInstance;
  private deviceId: string;
  private clientId: string;
  private observer: BackendObserver | null = null;
  private poller: ReturnType<typeof setInterval> | null = null;
  private stateListener: SpotifyPlayerListener | null = null;
  // Cached last-emitted phase so applyState can dedupe paused/playing
  // emissions on every poll tick. The 500ms poller fires twice per
  // second; without this cache, every tick during a long playback emits
  // a fresh phase event that fans out through the Player → Zustand →
  // every PlayButton subscribed to isPlaying, producing 2 Hz of
  // useless reconciliation across the entire virtualized table.
  // null = no phase emitted yet (initial state); reset on stop().
  private lastEmittedPaused: boolean | null = null;

  constructor(opts: {
    player: SpotifyPlayerInstance;
    deviceId: string;
    clientId: string;
  }) {
    this.player = opts.player;
    this.deviceId = opts.deviceId;
    this.clientId = opts.clientId;
  }

  setObserver(observer: BackendObserver | null): void {
    // No side effects: the listener + poller are scoped to load()/stop()
    // so an idle SDK backend (created but never asked to play) doesn't
    // burn a getCurrentState() RPC every 500 ms for no reason.
    this.observer = observer;
  }

  async load(source: PlaybackSource): Promise<boolean> {
    if (source.kind !== "spotify-sdk") return false;
    try {
      await playSpotifyTrackOnDevice(source.uri, this.deviceId, this.clientId);
      this.attachSdkListener();
      this.startPoller();
      // The SDK's player_state_changed event will promote phase to
      // "playing" once playback starts. We don't synthesize a "playing"
      // event here because the actual play may be delayed by the
      // device.
      return true;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "unknown SDK error";
      this.observer?.({ kind: "error", message: `Spotify SDK: ${message}` });
      return false;
    }
  }

  async pause(): Promise<void> {
    try {
      await pauseSpotifyPlayback(this.player);
    } catch (error) {
      console.warn("Spotify SDK pause failed", error);
    }
  }

  async resume(): Promise<void> {
    try {
      await resumeSpotifyPlayback(this.player);
    } catch (error) {
      console.warn("Spotify SDK resume failed", error);
    }
  }

  async stop(): Promise<void> {
    // The SDK has no real "stop" — pause is the cleanest substitute.
    // Detach the listener + poller so a paused-by-stop doesn't leak
    // a stale "paused" event into the observer after the Player has
    // already moved on.
    this.detachSdkListener();
    this.stopPoller();
    // Reset the phase dedupe cache: a fresh load() on this backend
    // must emit its first phase event unconditionally, even if it
    // happens to match the last phase from the prior playback.
    this.lastEmittedPaused = null;
    try {
      await pauseSpotifyPlayback(this.player);
    } catch (error) {
      console.warn("Spotify SDK pause failed", error);
    }
  }

  async seek(positionMs: number): Promise<void> {
    try {
      await seekSpotifyPlayback(this.player, positionMs);
    } catch (error) {
      console.warn("Spotify SDK seek failed", error);
    }
  }

  private attachSdkListener(): void {
    if (this.stateListener) return;
    const listener: SpotifyPlayerListener = (data) => {
      const state = data as SpotifyPlayerSdkState | null;
      this.applyState(state);
    };
    this.player.addListener("player_state_changed", listener);
    this.stateListener = listener;
  }

  private detachSdkListener(): void {
    if (!this.stateListener) return;
    this.player.removeListener("player_state_changed", this.stateListener);
    this.stateListener = null;
  }

  private startPoller(): void {
    if (this.poller !== null) return;
    this.poller = setInterval(() => {
      void this.player
        .getCurrentState()
        .then((state) => this.applyState(state))
        .catch(() => {
          // getCurrentState rejects when the device is no longer
          // active. Don't spam the console; the event listener will
          // fire if state actually changes.
        });
    }, POLL_INTERVAL_MS);
  }

  private stopPoller(): void {
    if (this.poller !== null) {
      clearInterval(this.poller);
      this.poller = null;
    }
  }

  private applyState(state: SpotifyPlayerSdkState | null): void {
    if (!state) return;
    if (!this.observer) return;
    // Translate state into the BackendEvent stream. Position is always
    // useful; the playing/paused event ONLY fires on a real transition
    // to avoid 2 Hz of useless reconciliation across every
    // PlayButton/Toolbar subscriber during a long playback. The
    // Player's handleBackendEvent is also idempotent on same-phase
    // patches, but de-duping here cuts the work at the source.
    this.observer({
      kind: "position",
      positionMs: state.position,
      durationMs: state.duration,
    });
    if (this.lastEmittedPaused !== state.paused) {
      this.lastEmittedPaused = state.paused;
      this.observer(state.paused ? { kind: "paused" } : { kind: "playing" });
    }
  }
}
