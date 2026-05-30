// Backend that wraps a single shared HTMLAudioElement. Used for local
// files and Spotify 30-second previews — both of which speak the
// HTMLMediaElement API. The Player owns the lifecycle; this backend
// translates DOM events into BackendEvents and exposes pause/resume/
// stop/seek primitives.

import type { Backend, BackendEvent, BackendObserver } from "./player";
import { getAudioElementUrl, type PlaybackSource } from "./playbackSource";

// MediaError.MEDIA_ERR_ABORTED is spec-fixed at 1. We reference the
// global constant when it exists (real browsers), but fall back to the
// literal so non-browser test environments (happy-dom doesn't expose a
// global `MediaError`) don't throw a ReferenceError reading it. Naming
// it here keeps the abort check in attachListeners() self-documenting.
const MEDIA_ERR_ABORTED: number =
  typeof MediaError !== "undefined" ? MediaError.MEDIA_ERR_ABORTED : 1;

export class HtmlAudioBackend implements Backend {
  readonly kind = "html-audio" as const;
  private audio: HTMLAudioElement;
  private observer: BackendObserver | null = null;
  // Hold each (event, handler) pair so dispose() can detach exactly the
  // listeners we added. Anonymous arrow handlers can't be removed, which
  // would leak this backend (and its closed-over observer) for the life
  // of the <audio> element across a teardown/re-init cycle.
  private listenerBindings: Array<[string, EventListener]> = [];

  constructor(audio: HTMLAudioElement) {
    this.audio = audio;
    this.audio.preload = "metadata";
    this.attachListeners();
  }

  setObserver(observer: BackendObserver | null): void {
    this.observer = observer;
  }

  /**
   * Tear down for app unmount / store teardown. Pauses the element and
   * removes every DOM listener this backend attached so the <audio>
   * element can be GC'd (or safely reused by a re-initialized Player)
   * without leaking the old observer. Idempotent — a second call finds
   * no bindings to remove. After dispose() the backend must not be
   * reused; the store builds a fresh one on the next initialize().
   */
  dispose(): void {
    this.audio.pause();
    for (const [event, handler] of this.listenerBindings) {
      this.audio.removeEventListener(event, handler);
    }
    this.listenerBindings = [];
    this.observer = null;
  }

  async load(source: PlaybackSource): Promise<boolean> {
    const url = getAudioElementUrl(source);
    if (!url) return false;
    // Assigning a new src on the audio element automatically aborts
    // any prior load and starts the new one. We deliberately do NOT
    // pause first — pause-then-set-src-then-play is the pattern that
    // races with the browser's media pipeline and leaves the new
    // play() promise pending forever in some browsers.
    this.audio.src = url;
    try {
      await this.audio.play();
      return true;
    } catch (error) {
      if (error instanceof DOMException) {
        // AbortError: a newer load() superseded this one. Not a real
        // failure — the new caller owns the next state.
        if (error.name === "AbortError") return false;
        if (error.name === "NotAllowedError") {
          this.observer?.({
            kind: "error",
            message:
              "browser blocked autoplay — click play again to allow audio",
          });
          return false;
        }
      }
      const detail = error instanceof Error ? error.message : String(error);
      this.observer?.({ kind: "error", message: detail });
      return false;
    }
  }

  async pause(): Promise<void> {
    this.audio.pause();
  }

  async resume(): Promise<void> {
    try {
      await this.audio.play();
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      const detail = error instanceof Error ? error.message : String(error);
      this.observer?.({ kind: "error", message: detail });
    }
  }

  /**
   * Pause the element. The Player only calls stop() on the backend
   * that is being switched AWAY from — same-backend transitions go
   * directly to load() and let `audio.src = newUrl` perform the
   * replacement, which avoids the pause→set-src→play race.
   */
  async stop(): Promise<void> {
    this.audio.pause();
  }

  async seek(positionMs: number): Promise<void> {
    if (!Number.isFinite(positionMs)) return;
    try {
      this.audio.currentTime = positionMs / 1000;
    } catch (error) {
      console.warn("html-audio seek failed", error);
    }
  }

  private attachListeners(): void {
    this.on("play", () => this.emit({ kind: "playing" }));
    this.on("pause", () => this.emit({ kind: "paused" }));
    this.on("ended", () => this.emit({ kind: "ended" }));
    this.on("timeupdate", () => this.emitPosition());
    this.on("loadedmetadata", () => this.emitPosition());
    this.on("durationchange", () => this.emitPosition());
    this.on("seeked", () => this.emitPosition());
    this.on("error", () => {
      const error = this.audio.error;
      // Two cases are NOT user-facing failures and must be dropped:
      //   1. error === null — a synthetic/late "error" event with no
      //      MediaError attached (e.g. one that fires after stop() when
      //      audio.error is null). Nothing to surface.
      //   2. MEDIA_ERR_ABORTED — the element's natural response to
      //      `audio.src = newUrl` aborting the prior load. Expected.
      // Anything else is a real media error worth a toast. Comparing
      // against the MEDIA_ERR_ABORTED *constant* (rather than reading the
      // code off the possibly-null instance via optional chaining) makes
      // the intent explicit and refactor-safe.
      if (!error || error.code === MEDIA_ERR_ABORTED) {
        return;
      }
      this.emit({ kind: "error", message: describeMediaError(this.audio) });
    });
  }

  /** Register a listener and record the binding so dispose() can detach it. */
  private on(event: string, handler: EventListener): void {
    this.audio.addEventListener(event, handler);
    this.listenerBindings.push([event, handler]);
  }

  private emit(event: BackendEvent): void {
    this.observer?.(event);
  }

  private emitPosition(): void {
    const t = this.audio.currentTime;
    const d = this.audio.duration;
    const positionMs =
      Number.isFinite(t) && t >= 0 ? Math.floor(t * 1000) : 0;
    const durationMs =
      Number.isFinite(d) && d > 0 ? Math.floor(d * 1000) : 0;
    this.emit({ kind: "position", positionMs, durationMs });
  }
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
