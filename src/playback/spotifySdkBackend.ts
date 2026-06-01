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
import { SPOTIFY_SDK_POLL_INTERVAL_MS } from "../constants";
import type { Backend, BackendObserver } from "./player";
import type { PlaybackSource } from "./playbackSource";

export class SpotifySdkBackend implements Backend {
  readonly kind = "spotify-sdk" as const;
  private player: SpotifyPlayerInstance;
  private deviceId: string;
  private clientId: string;
  private observer: BackendObserver | null = null;
  private poller: ReturnType<typeof setInterval> | null = null;
  // Bumped every time the poller is torn down (stop/dispose). A
  // getCurrentState() RPC dispatched on the last tick before stop() can
  // resolve AFTER stop() ran — the captured generation lets its `.then`
  // detect that the poller it belonged to is gone and drop the stale
  // state instead of emitting a position/phase event after the Player
  // already moved on.
  private pollGeneration = 0;
  private stateListener: SpotifyPlayerListener | null = null;
  // Cached last-emitted phase so applyState can dedupe paused/playing
  // emissions on every poll tick. The 500ms poller fires twice per
  // second; without this cache, every tick during a long playback emits
  // a fresh phase event that fans out through the Player → Zustand →
  // every PlayButton subscribed to isPlaying, producing 2 Hz of
  // useless reconciliation across the entire virtualized table.
  // null = no phase emitted yet (initial state); reset on stop().
  private lastEmittedPaused: boolean | null = null;
  // Whether playback has actually started since the last load(). Needed
  // to detect end-of-track: the SDK reports a finished track as
  // {paused:true, position:0}, which is indistinguishable from the
  // initial paused-at-load state without knowing we've played since.
  private hasPlayed = false;

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
    // Reset the phase dedupe cache on every load, not just stop(). The
    // Player skips stop() on a same-backend SDK→SDK switch, so without
    // this a new track that happens to start in the same paused/playing
    // phase as the previous one ended would have its first phase event
    // suppressed — leaving the UI showing the prior track's phase until
    // the next real transition.
    this.lastEmittedPaused = null;
    this.hasPlayed = false;
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
      // Defensively (re)start the position poller. A mid-track pause stops
      // the poller to spare the rate limiter (see applyState), counting on
      // the SDK's player_state_changed (paused:false) to restart it on
      // resume. But that event isn't guaranteed to fire on every resume —
      // and even when it does, the phase-dedupe in applyState suppresses
      // the restart if `lastEmittedPaused` was already flipped to false by
      // an interleaving event. Without an independent restart here, the
      // poller can stay dead and position updates freeze. startPoller() is
      // idempotent (no-ops when a poller is already running), so calling it
      // unconditionally on resume can't double-schedule.
      this.startPoller();
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
    this.hasPlayed = false;
    try {
      await pauseSpotifyPlayback(this.player);
    } catch (error) {
      console.warn("Spotify SDK pause failed", error);
    }
  }

  /**
   * Teardown hook called by Player.dispose(). Detaches the SDK state
   * listener and halts the poller so no timer or listener outlives the
   * Player. We deliberately do NOT disconnect the underlying SDK player
   * here — that singleton is owned by spotifyPlayer.ts and torn down via
   * destroySpotifyPlayer() (the store's teardown calls both). Idempotent.
   */
  dispose(): void {
    this.detachSdkListener();
    this.stopPoller();
    this.lastEmittedPaused = null;
    this.hasPlayed = false;
    this.observer = null;
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
    const generation = this.pollGeneration;
    // Re-entrancy guard: getCurrentState() can occasionally take longer
    // than the 500ms interval. Without this, a slow RPC lets a second
    // fire before the first resolves, and out-of-order resolution could
    // emit a position that jumps backwards.
    let inFlight = false;
    this.poller = setInterval(() => {
      if (inFlight) return;
      inFlight = true;
      void this.player
        .getCurrentState()
        .then((state) => {
          // Drop a result that resolved after this poller was torn down
          // (stop/dispose) or superseded by a new load — applyState would
          // otherwise emit a stale event after the Player moved on.
          if (generation !== this.pollGeneration) return;
          this.applyState(state);
        })
        .catch(() => {
          // getCurrentState rejects when the device is no longer
          // active. Don't spam the console; the event listener will
          // fire if state actually changes.
        })
        .finally(() => {
          inFlight = false;
        });
    }, SPOTIFY_SDK_POLL_INTERVAL_MS);
  }

  private stopPoller(): void {
    if (this.poller !== null) {
      clearInterval(this.poller);
      this.poller = null;
    }
    // Invalidate any getCurrentState() still in flight so its late
    // resolution can't emit into a stopped backend.
    this.pollGeneration++;
  }

  private applyState(state: SpotifyPlayerSdkState | null): void {
    if (!state) return;
    if (!this.observer) return;

    // End-of-track detection. The Web Playback SDK has no dedicated
    // "ended" event — a finished track surfaces as {paused:true,
    // position:0}. Distinguish that from a user pause (which leaves
    // position at the live playhead) and from the initial paused-at-load
    // state by requiring that playback has actually started since load()
    // (`hasPlayed`). Emitting `ended` rather than `paused` lets the
    // Player tear down the backend so a re-press reloads from the top
    // instead of issuing resume() against a completed Connect context
    // (DESIGN §4.4 — this distinction matters most for the SDK).
    if (this.hasPlayed && state.paused && state.position === 0) {
      this.hasPlayed = false;
      // Playback is done: stop our own poller/listener so we don't keep
      // burning a getCurrentState() RPC every 500ms after the track
      // ended. The Player deliberately does NOT call stop() on an ended
      // backend, so the backend is responsible for its own quiescence.
      this.detachSdkListener();
      this.stopPoller();
      this.lastEmittedPaused = null;
      this.observer({ kind: "ended" });
      return;
    }

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
    if (!state.paused) this.hasPlayed = true;
    if (this.lastEmittedPaused !== state.paused) {
      this.lastEmittedPaused = state.paused;
      this.observer(state.paused ? { kind: "paused" } : { kind: "playing" });
      // The playhead is static while paused, so the 500ms getCurrentState
      // poll is pure load against the Spotify rate limiter / circuit
      // breaker until playback resumes. Halt it on a genuine mid-playback
      // pause; `hasPlayed` guards out the paused-at-load state, where we
      // must keep polling until the device actually starts. The SDK's
      // player_state_changed listener still fires on resume (restarting
      // the poller here) and on end-of-track — and it, not the poller, is
      // what catches the {paused, position:0} end signal, so pausing the
      // poller never strands a finished track.
      if (state.paused) {
        if (this.hasPlayed) this.stopPoller();
      } else {
        this.startPoller();
      }
    }
  }
}
