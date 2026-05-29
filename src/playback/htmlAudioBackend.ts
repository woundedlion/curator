// Backend that wraps a single shared HTMLAudioElement. Used for local
// files and Spotify 30-second previews — both of which speak the
// HTMLMediaElement API. The Player owns the lifecycle; this backend
// translates DOM events into BackendEvents and exposes pause/resume/
// stop/seek primitives.

import type { Backend, BackendEvent, BackendObserver } from "./player";
import { getAudioElementUrl, type PlaybackSource } from "./playbackSource";

export class HtmlAudioBackend implements Backend {
  readonly kind = "html-audio" as const;
  private audio: HTMLAudioElement;
  private observer: BackendObserver | null = null;

  constructor(audio: HTMLAudioElement) {
    this.audio = audio;
    this.audio.preload = "metadata";
    this.attachListeners();
  }

  setObserver(observer: BackendObserver | null): void {
    this.observer = observer;
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
    this.audio.addEventListener("play", () => this.emit({ kind: "playing" }));
    this.audio.addEventListener("pause", () => this.emit({ kind: "paused" }));
    this.audio.addEventListener("ended", () => this.emit({ kind: "ended" }));
    this.audio.addEventListener("timeupdate", () => this.emitPosition());
    this.audio.addEventListener("loadedmetadata", () => this.emitPosition());
    this.audio.addEventListener("durationchange", () => this.emitPosition());
    this.audio.addEventListener("seeked", () => this.emitPosition());
    this.audio.addEventListener("error", () => {
      // MEDIA_ERR_ABORTED is the audio element's natural response to
      // `audio.src = newUrl` aborting the prior load — that's not a
      // user-facing failure, so silence it. Any other media error is
      // worth surfacing.
      if (this.audio.error?.code === this.audio.error?.MEDIA_ERR_ABORTED) {
        return;
      }
      this.emit({ kind: "error", message: describeMediaError(this.audio) });
    });
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
