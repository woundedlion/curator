// A playback Player that owns a small state machine and at most one
// active backend at a time. The Player exposes a narrow API
// (`play`, `togglePause`, `stop`, `stopIfCandidate`, `seek`) and
// guarantees three invariants that the previous ad-hoc code couldn't:
//
//   1. AT MOST ONE BACKEND IS PRODUCING AUDIO AT ANY MOMENT.
//      Every transition stops every backend EXCEPT the one we're about
//      to use. Same-backend transitions skip the stop and let the
//      backend perform in-place replacement (audio.src = newUrl on
//      HTMLAudio, the play API call on the SDK). Cross-backend
//      transitions stop the prior backend before loading the new one
//      — and clear `activeBackend` first so events the prior backend
//      fires during its pause window don't pollute the snapshot.
//
//   2. `currentTrackId` REFLECTS WHAT THE USER SHOULD BE ABLE TO STOP.
//      As long as a target is installed, the NowPlayingBar shows and
//      offers a Stop control. The id is only cleared once we've moved
//      to idle (no backend producing audio).
//
//   3. OPERATIONS ARE SERIALIZED.
//      Every public action goes through a single FIFO queue, so a
//      "stop" enqueued after an in-flight "play" runs AFTER the play
//      lands. This guarantees the picker's unmount cleanup catches
//      candidate playback even when the play happened to be in flight
//      at unmount time.
//
// The Player is decoupled from React, IndexedDB, and HTTP. Tests drive
// it directly with fake backends to assert the state machine.

import { releasePlaybackSource, type PlaybackSource } from "./playbackSource";

export type PlaybackDisplay = { title: string; artist: string };

export type PlayerPhase = "idle" | "loading" | "playing" | "paused";

// What's being played. `kind: "track"` is a user-facing playlist row;
// `kind: "candidate"` is a synthetic id the picker dialog uses for
// previewing Spotify search results. The distinction matters for
// `stopIfCandidate` — the picker's cleanup must not stop main-view
// playback.
export type PlayerTarget = {
  kind: "track" | "candidate";
  id: string; // "track-abc" for tracks, "candidate:spotify:track:xyz" for candidates
  display: PlaybackDisplay;
  durationMs: number;
  source: PlaybackSource;
};

export type PlayerSnapshot = {
  phase: PlayerPhase;
  target: PlayerTarget | null;
  positionMs: number;
  durationMs: number;
  // Derived: convenience for UI subscribers.
  isPlaying: boolean;
  currentTrackId: string | null;
};

const IDLE_SNAPSHOT: PlayerSnapshot = {
  phase: "idle",
  target: null,
  positionMs: 0,
  durationMs: 0,
  isPlaying: false,
  currentTrackId: null,
};

// ─── Backend port ─────────────────────────────────────────────────────
// A Backend is anything that can play one source at a time and report
// its state. The Player owns the policy; backends own the mechanism.

export type BackendKind = "html-audio" | "spotify-sdk";

export type BackendEvent =
  | { kind: "playing" }
  | { kind: "paused" }
  | { kind: "ended" }
  | { kind: "position"; positionMs: number; durationMs: number }
  | { kind: "error"; message: string };

export type BackendObserver = (event: BackendEvent) => void;

export interface Backend {
  readonly kind: BackendKind;
  /** Returns true on success. On false, the player stays in idle. */
  load(source: PlaybackSource): Promise<boolean>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  /** Pause + clear any internal state. Must be safe to call when idle. */
  stop(): Promise<void>;
  seek(positionMs: number): Promise<void>;
  /** The player attaches one observer per backend. */
  setObserver(observer: BackendObserver | null): void;
}

// ─── Player ───────────────────────────────────────────────────────────

export type PlayerOptions = {
  htmlBackend: Backend;
  /**
   * Lazy SDK loader. Returns the SDK backend on first SDK-required
   * play, or null when the SDK can't be initialized (no client id,
   * non-Premium account, etc.). The player calls this AT MOST ONCE per
   * Player lifetime — if it returns null the second SDK-required play
   * will hit the same null result without re-asking.
   */
  sdkLoader: () => Promise<Backend | null>;
  /** Toast surface for surfaced errors. Optional for tests. */
  onError?: (message: string) => void;
};

export class Player {
  private snapshot: PlayerSnapshot = IDLE_SNAPSHOT;
  private htmlBackend: Backend;
  private sdkBackend: Backend | null = null;
  private sdkLoadAttempted = false;
  private activeBackend: Backend | null = null;
  private listeners = new Set<(s: PlayerSnapshot) => void>();
  private opQueue: Promise<void> = Promise.resolve();
  private sdkLoader: () => Promise<Backend | null>;
  private onError: (message: string) => void;

  constructor(options: PlayerOptions) {
    this.htmlBackend = options.htmlBackend;
    this.sdkLoader = options.sdkLoader;
    this.onError = options.onError ?? (() => undefined);
    this.htmlBackend.setObserver((event) =>
      this.handleBackendEvent(this.htmlBackend, event),
    );
  }

  // ─── Public API ─────────────────────────────────────────────────────

  /**
   * Play the given target. If the target is already current, this
   * toggles pause/resume. Otherwise it stops the prior backend and
   * loads the new one.
   */
  play(target: PlayerTarget): Promise<void> {
    return this.enqueue(async () => {
      if (this.snapshot.currentTrackId === target.id) {
        await this.togglePauseInternal();
        return;
      }
      await this.install(target);
    });
  }

  /**
   * Toggle pause/resume on the current target. No-op if `id` doesn't
   * match the active target — protects against stale UI callbacks.
   */
  togglePause(id: string): Promise<void> {
    return this.enqueue(async () => {
      if (this.snapshot.currentTrackId !== id) return;
      await this.togglePauseInternal();
    });
  }

  /** Stop everything, regardless of backend. Idempotent. */
  stop(): Promise<void> {
    return this.enqueue(() => this.doStop());
  }

  /**
   * Stop only if the current target is a candidate (picker preview).
   * Lets the dialog clean up its own playback on unmount without
   * touching main-view playback. Serialized through the same queue as
   * other ops, so an enqueued stop after an in-flight candidate play
   * still catches that play.
   */
  stopIfCandidate(): Promise<void> {
    return this.enqueue(async () => {
      if (this.snapshot.target?.kind === "candidate") {
        await this.doStop();
      }
    });
  }

  seek(positionMs: number): Promise<void> {
    return this.enqueue(async () => {
      if (!this.activeBackend) return;
      if (this.snapshot.currentTrackId === null) return;
      const clamped =
        this.snapshot.durationMs > 0
          ? Math.max(0, Math.min(positionMs, this.snapshot.durationMs))
          : Math.max(0, positionMs);
      // Optimistically reflect the new playhead so the UI doesn't snap
      // back to the old position while the backend acks the seek.
      this.patch({ positionMs: clamped });
      await this.activeBackend.seek(clamped);
    });
  }

  // ─── Subscriptions ──────────────────────────────────────────────────

  subscribe(listener: (snapshot: PlayerSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getSnapshot(): PlayerSnapshot {
    return this.snapshot;
  }

  /**
   * Test-only seam: drains the operation queue so assertions can
   * observe steady state. Equivalent to awaiting whatever's currently
   * queued — the queue self-extends as new ops arrive.
   */
  async drainForTests(): Promise<void> {
    await this.opQueue;
  }

  // ─── Internal ───────────────────────────────────────────────────────

  /**
   * The ONLY way a new target enters the player. Stops every backend
   * EXCEPT the new one so cross-backend transitions can't leave the
   * prior backend running; same-backend transitions skip the stop and
   * let the backend perform in-place replacement (audio.src = newUrl,
   * or the SDK's play command).
   */
  private async install(target: PlayerTarget): Promise<void> {
    const priorSource = this.snapshot.target?.source;
    const newBackend = await this.resolveBackend(target.source);
    if (!newBackend) {
      // No backend available — leave idle so the UI doesn't paint a
      // now-playing row for silent audio.
      await this.stopAll();
      this.transitionToIdle();
      if (priorSource) releasePlaybackSource(priorSource);
      return;
    }

    await this.stopAllExcept(newBackend);
    // Prior backend has unloaded, so the prior source's object URL (if
    // it has one) is no longer in use by anyone. Release before patching
    // in the new target.
    if (priorSource) releasePlaybackSource(priorSource);

    this.activeBackend = newBackend;
    this.patch({
      phase: "loading",
      target,
      positionMs: 0,
      durationMs: target.durationMs,
    });

    const ok = await newBackend.load(target.source);
    if (!ok) {
      await this.stopAll();
      this.transitionToIdle();
      releasePlaybackSource(target.source);
      return;
    }
    // Defensive: promote to "playing" as soon as the backend commits.
    // Some backends emit a native "playing" event during load() (HTML
    // audio fires it inside `await audio.play()`), but some don't
    // (the SDK fires its state event after a round-trip). Setting
    // here means the UI updates immediately; the native event is
    // idempotent if it does arrive.
    if (this.snapshot.phase === "loading") {
      this.patch({ phase: "playing" });
    }
  }

  private async togglePauseInternal(): Promise<void> {
    if (!this.activeBackend) return;
    if (this.snapshot.phase === "playing") {
      await this.activeBackend.pause();
      this.patch({ phase: "paused" });
    } else if (this.snapshot.phase === "paused") {
      await this.activeBackend.resume();
      this.patch({ phase: "playing" });
    }
  }

  private async doStop(): Promise<void> {
    const priorSource = this.snapshot.target?.source;
    await this.stopAll();
    this.transitionToIdle();
    if (priorSource) releasePlaybackSource(priorSource);
  }

  /**
   * Stop every backend. Use for full teardown (public `stop`, error
   * rollback). Clears `activeBackend` before awaiting the pauses so
   * any events the backends fire during their stop window are
   * ignored by `handleBackendEvent` instead of overwriting the
   * snapshot.
   */
  private async stopAll(): Promise<void> {
    this.activeBackend = null;
    const sdkStop = this.sdkBackend?.stop() ?? Promise.resolve();
    await Promise.all([this.htmlBackend.stop(), sdkStop]);
  }

  /**
   * Stop every backend EXCEPT `keep`. Used by `install` to pause the
   * prior backend in cross-backend transitions while leaving the
   * incoming one untouched (pausing the incoming backend before its
   * load() races with the browser's media pipeline).
   */
  private async stopAllExcept(keep: Backend): Promise<void> {
    this.activeBackend = null;
    const others: Backend[] = [];
    if (this.htmlBackend !== keep) others.push(this.htmlBackend);
    if (this.sdkBackend && this.sdkBackend !== keep) {
      others.push(this.sdkBackend);
    }
    await Promise.all(others.map((b) => b.stop()));
  }

  private async resolveBackend(source: PlaybackSource): Promise<Backend | null> {
    if (source.kind === "local" || source.kind === "spotify-preview") {
      return this.htmlBackend;
    }
    if (source.kind === "spotify-sdk") {
      if (this.sdkBackend) return this.sdkBackend;
      if (this.sdkLoadAttempted) return null;
      this.sdkLoadAttempted = true;
      let loaded: Backend | null;
      try {
        loaded = await this.sdkLoader();
      } catch (error) {
        // A throwing loader (network error, unhandled SDK exception)
        // would otherwise propagate up through install() and reject the
        // caller's play() promise with no UI feedback. Treat as
        // unavailable: surface to onError so a toast fires, and stick
        // sdkLoadAttempted=true so we don't keep re-throwing on retries.
        this.onError(
          error instanceof Error
            ? `Spotify SDK init failed: ${error.message}`
            : "Spotify SDK init failed",
        );
        return null;
      }
      if (!loaded) return null;
      this.sdkBackend = loaded;
      this.sdkBackend.setObserver((event) =>
        this.handleBackendEvent(this.sdkBackend!, event),
      );
      return this.sdkBackend;
    }
    return null;
  }

  private handleBackendEvent(source: Backend, event: BackendEvent): void {
    // Ignore events from a backend that's no longer the active one —
    // they're stale (e.g. an SDK position event arriving after we
    // switched to HTML audio, or a "paused" event from the prior
    // backend during a cross-backend stop). Without this guard, those
    // events would corrupt the now-playing display.
    if (source !== this.activeBackend) return;

    switch (event.kind) {
      case "playing":
        this.patch({ phase: "playing" });
        return;
      case "paused":
        this.patch({ phase: "paused" });
        return;
      case "ended":
        // Target stays installed so the toolbar remains visible and
        // the user can re-press play; only the phase + playhead reset.
        this.patch({ phase: "paused", positionMs: 0 });
        return;
      case "position":
        // Preserve a known duration if the backend reports 0 — some
        // poll cycles fire with duration=0 while the actual track is
        // still loaded. The contract: 0 means "unknown right now."
        this.patch({
          positionMs: event.positionMs,
          durationMs:
            event.durationMs > 0 ? event.durationMs : this.snapshot.durationMs,
        });
        return;
      case "error":
        this.onError(event.message);
        // Roll back to idle so the UI doesn't claim audio is playing
        // when the backend has already failed.
        void this.enqueue(() => this.doStop());
        return;
    }
  }

  /**
   * Shallow-merge a patch into the snapshot, recompute derived fields
   * (`isPlaying`, `currentTrackId`), and notify subscribers. Spread
   * semantics handle target updates naturally: omit `target` to keep
   * the current one, include `target: null` to explicitly clear it.
   */
  private patch(p: Partial<PlayerSnapshot>): void {
    const merged: PlayerSnapshot = { ...this.snapshot, ...p };
    this.snapshot = {
      ...merged,
      isPlaying: merged.phase === "playing",
      currentTrackId: merged.target?.id ?? null,
    };
    this.emit();
  }

  private transitionToIdle(): void {
    this.snapshot = IDLE_SNAPSHOT;
    this.activeBackend = null;
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener(this.snapshot);
  }

  private enqueue(fn: () => Promise<void>): Promise<void> {
    const next = this.opQueue.then(fn, fn);
    // .catch onto resolved so one failure doesn't poison subsequent
    // operations. Surfaced failures still propagate to the caller via
    // `next`; we just don't let the chain head reject.
    this.opQueue = next.catch(() => undefined);
    return next;
  }
}
