// Exhaustive state-machine tests for the Player abstraction.
//
// The three load-bearing invariants the Player exists to enforce:
//
//   I1. AT MOST ONE BACKEND IS PRODUCING AUDIO AT ANY MOMENT.
//   I2. As long as ANY backend has been told to play, `currentTrackId`
//       is set (so the NowPlayingBar can show a Stop control).
//   I3. Operations are serialized — a stop enqueued after a play
//       always runs after the play lands.
//
// We use FakeBackend instances that record their pause/load/stop calls
// and let tests emit BackendEvents directly, so the state machine can
// be driven deterministically without real audio/SDK.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { Player, type Backend, type BackendObserver, type PlayerTarget } from "./player";
import type { PlaybackSource } from "./playbackSource";

// ─── Fake backend ────────────────────────────────────────────────────

type Call =
  | { kind: "load"; source: PlaybackSource }
  | { kind: "pause" }
  | { kind: "resume" }
  | { kind: "stop" }
  | { kind: "seek"; positionMs: number };

class FakeBackend implements Backend {
  readonly kind: "html-audio" | "spotify-sdk";
  private observer: BackendObserver | null = null;
  /** Resolved value of the next load() call. */
  loadResult = true;
  /** Promise that load() awaits before resolving. Lets tests gate load. */
  loadGate: Promise<void> = Promise.resolve();
  /** Every call to this backend, in order. */
  calls: Call[] = [];

  constructor(kind: "html-audio" | "spotify-sdk") {
    this.kind = kind;
  }

  setObserver(observer: BackendObserver | null): void {
    this.observer = observer;
  }

  async load(source: PlaybackSource): Promise<boolean> {
    this.calls.push({ kind: "load", source });
    await this.loadGate;
    return this.loadResult;
  }
  async pause(): Promise<void> {
    this.calls.push({ kind: "pause" });
  }
  async resume(): Promise<void> {
    this.calls.push({ kind: "resume" });
  }
  async stop(): Promise<void> {
    this.calls.push({ kind: "stop" });
  }
  async seek(positionMs: number): Promise<void> {
    this.calls.push({ kind: "seek", positionMs });
  }

  /** Test helper: synthesize backend events to drive the player. */
  emit(event: Parameters<BackendObserver>[0]): void {
    this.observer?.(event);
  }
}

// ─── Fixtures ────────────────────────────────────────────────────────

function localTrack(id: string): PlayerTarget {
  return {
    kind: "track",
    id,
    display: { title: `T${id}`, artist: `A${id}` },
    durationMs: 200_000,
    source: { kind: "local", objectUrl: `blob://${id}`, label: "Local file" },
  };
}

function previewTrack(id: string): PlayerTarget {
  return {
    kind: "track",
    id,
    display: { title: `T${id}`, artist: `A${id}` },
    durationMs: 30_000,
    source: {
      kind: "spotify-preview",
      url: `https://p.scdn.co/${id}.mp3`,
      label: "Spotify preview (30s)",
    },
  };
}

function sdkTrack(id: string): PlayerTarget {
  return {
    kind: "track",
    id,
    display: { title: `T${id}`, artist: `A${id}` },
    durationMs: 240_000,
    source: {
      kind: "spotify-sdk",
      uri: `spotify:track:${id}`,
      label: "Spotify (full track)",
    },
  };
}

function sdkCandidate(uri: string): PlayerTarget {
  return {
    kind: "candidate",
    id: `candidate:${uri}`,
    display: { title: "Candidate", artist: "Artist" },
    durationMs: 200_000,
    source: { kind: "spotify-sdk", uri, label: "Spotify (full track)" },
  };
}

function previewCandidate(uri: string, previewUrl: string): PlayerTarget {
  return {
    kind: "candidate",
    id: `candidate:${uri}`,
    display: { title: "Candidate", artist: "Artist" },
    durationMs: 30_000,
    source: {
      kind: "spotify-preview",
      url: previewUrl,
      label: "Spotify preview (30s)",
    },
  };
}

// ─── Setup ───────────────────────────────────────────────────────────

let html: FakeBackend;
let sdk: FakeBackend;
let sdkLoader: ReturnType<typeof vi.fn>;
let player: Player;
let errors: string[];

beforeEach(() => {
  html = new FakeBackend("html-audio");
  sdk = new FakeBackend("spotify-sdk");
  sdkLoader = vi.fn(async () => sdk);
  errors = [];
  player = new Player({
    htmlBackend: html,
    sdkLoader,
    onError: (m) => errors.push(m),
  });
});

// ─── I3: Operation serialization (drained-state assertions) ──────────

async function drain(): Promise<void> {
  await player.drainForTests();
}

// ─── 1. Basic lifecycle ──────────────────────────────────────────────

describe("Player — basic lifecycle", () => {
  it("starts in idle with no target and no active backend", () => {
    const s = player.getSnapshot();
    expect(s.phase).toBe("idle");
    expect(s.target).toBeNull();
    expect(s.currentTrackId).toBeNull();
    expect(s.isPlaying).toBe(false);
  });

  it("transitions idle → loading → playing on first play", async () => {
    const target = localTrack("a");
    await player.play(target);
    // First play goes directly to load — there's no prior backend to
    // stop. (Pausing the new backend before load creates a race that
    // can break audio in some browsers; we deliberately skip it.)
    expect(html.calls).toEqual([
      { kind: "load", source: target.source },
    ]);
    // Backend emits the "playing" event when it actually starts.
    html.emit({ kind: "playing" });
    const s = player.getSnapshot();
    expect(s.phase).toBe("playing");
    expect(s.currentTrackId).toBe("a");
    expect(s.isPlaying).toBe(true);
  });

  it("REGRESSION: phase is promoted to 'playing' as soon as backend.load resolves true, even if no 'playing' event fires", async () => {
    // Real-world bug: in some browsers / SDK warm-up paths, the
    // backend's `playing` event doesn't fire promptly after load
    // resolves true. The user sees the now-playing bar (target is
    // installed) but isPlaying stays false — the play button never
    // flips to pause and the UI looks like "playing doesn't work."
    // The Player must promote to "playing" defensively when load
    // commits, NOT wait for an event that may never arrive.
    await player.play(localTrack("a"));
    // Deliberately do NOT emit a "playing" event from the backend.
    const s = player.getSnapshot();
    expect(s.phase).toBe("playing");
    expect(s.isPlaying).toBe(true);
    expect(s.currentTrackId).toBe("a");
  });

  it("loading phase exposes a target so the toolbar is visible while audio loads", async () => {
    let resolveGate: () => void = () => undefined;
    html.loadGate = new Promise<void>((r) => {
      resolveGate = r;
    });
    // Observe the phase sequence via subscription — that way we don't
    // have to guess the right number of microtask yields to catch the
    // "loading" snapshot before it transitions.
    const phases: string[] = [];
    let sawLoadingTrackId: string | null = null;
    player.subscribe((s) => {
      phases.push(s.phase);
      if (s.phase === "loading") sawLoadingTrackId = s.currentTrackId;
    });
    const playPromise = player.play(localTrack("a"));
    // Yield until the loading phase has been emitted.
    while (!phases.includes("loading")) await Promise.resolve();
    expect(sawLoadingTrackId).toBe("a");
    resolveGate();
    await playPromise;
  });
});

// ─── 2. The "never double-play" invariant ────────────────────────────

describe("Player — at most one backend is producing audio (I1)", () => {
  it("HTMLAudio → HTMLAudio: in-place src replacement (no spurious pause-before-load)", async () => {
    // Same-backend transitions deliberately skip the pause: setting
    // a fresh audio.src auto-aborts the prior playback. A pause
    // before the new load() races with the browser's media pipeline
    // and breaks audio in some browsers (the original regression).
    await player.play(localTrack("a"));
    html.emit({ kind: "playing" });
    html.calls.length = 0;
    await player.play(localTrack("b"));
    // Exactly ONE load, no stop on the same backend.
    expect(html.calls).toEqual([
      { kind: "load", source: localTrack("b").source },
    ]);
  });

  it("SDK → HTMLAudio: the OTHER (SDK) backend is stopped; HTMLAudio is NOT pre-paused", async () => {
    await player.play(sdkTrack("x"));
    sdk.emit({ kind: "playing" });
    html.calls.length = 0;
    sdk.calls.length = 0;
    await player.play(localTrack("a"));
    // The SDK was the prior backend — must be stopped so it doesn't
    // keep playing. The HTML backend is NEW — must NOT be pre-paused
    // (that's what broke real-world playback).
    expect(sdk.calls).toContainEqual({ kind: "stop" });
    expect(html.calls).not.toContainEqual({ kind: "stop" });
    expect(html.calls).toContainEqual({
      kind: "load",
      source: localTrack("a").source,
    });
  });

  it("HTMLAudio → SDK: the OTHER (HTMLAudio) backend is stopped; SDK is NOT pre-paused", async () => {
    await player.play(previewTrack("a"));
    html.emit({ kind: "playing" });
    html.calls.length = 0;
    sdk.calls.length = 0;
    await player.play(sdkTrack("x"));
    expect(sdkLoader).toHaveBeenCalledTimes(1);
    expect(html.calls).toContainEqual({ kind: "stop" });
    expect(sdk.calls).not.toContainEqual({ kind: "stop" });
    expect(sdk.calls).toContainEqual({
      kind: "load",
      source: sdkTrack("x").source,
    });
  });

  it("candidate playback stops the prior cross-backend track (the picker bug)", async () => {
    // User plays main-view track via HTMLAudio preview.
    await player.play(previewTrack("main"));
    html.emit({ kind: "playing" });
    html.calls.length = 0;
    sdk.calls.length = 0;
    // User clicks play on a SDK-required candidate in the picker.
    await player.play(sdkCandidate("spotify:track:xyz"));
    expect(html.calls).toContainEqual({ kind: "stop" }); // main view stopped
    expect(sdk.calls).toContainEqual({
      kind: "load",
      source: { kind: "spotify-sdk", uri: "spotify:track:xyz", label: expect.any(String) },
    });
  });

  it("stale events from the OLD backend after a switch are ignored", async () => {
    await player.play(sdkTrack("x"));
    sdk.emit({ kind: "playing" });
    await player.play(localTrack("a"));
    html.emit({ kind: "playing" });
    // The SDK fires a delayed "paused" event (from the stop) after
    // HTML is already the active backend. It must not flip the
    // player's phase or rewrite the target.
    sdk.emit({ kind: "paused" });
    const s = player.getSnapshot();
    expect(s.phase).toBe("playing");
    expect(s.currentTrackId).toBe("a");
  });

  it("REGRESSION: events from the prior backend mid-stop don't pollute the snapshot", async () => {
    // The prior bug: `activeBackend` stayed pointing at the old
    // backend during `await activeBackend.stop()`, so a "paused"
    // event fired by the stop window would flip phase to "paused"
    // with the old target still attached. Clearing activeBackend
    // BEFORE awaiting the stop discards those events cleanly.
    await player.play(sdkTrack("x"));
    sdk.emit({ kind: "playing" });
    // Hold the SDK's stop so we can observe what happens mid-stop.
    let resolveStop: () => void = () => undefined;
    const heldStop = new Promise<void>((r) => {
      resolveStop = r;
    });
    const realStop = sdk.stop.bind(sdk);
    sdk.stop = async () => {
      // Synthesize a "paused" event from the (no-longer-active)
      // prior backend, then await the held promise.
      sdk.emit({ kind: "paused" });
      await heldStop;
      return realStop();
    };

    const playPromise = player.play(localTrack("a"));
    // Let the stop kick off + the spurious "paused" event fire.
    for (let i = 0; i < 5; i++) await Promise.resolve();
    // Phase must NOT have flipped to "paused" from the stale event.
    // Before the fix, `activeBackend` still pointed at the SDK during
    // the await, so the paused event was accepted and set phase to
    // "paused" with the old target still attached.
    expect(player.getSnapshot().phase).not.toBe("paused");
    resolveStop();
    await playPromise;
    html.emit({ kind: "playing" });
    expect(player.getSnapshot().phase).toBe("playing");
    expect(player.getSnapshot().currentTrackId).toBe("a");
  });
});

// ─── 3. "Toolbar is always visible while a backend has been told to play" (I2)

describe("Player — currentTrackId reflects what can be stopped (I2)", () => {
  it("currentTrackId is set throughout loading + playing + paused", async () => {
    let resolveGate: () => void = () => undefined;
    html.loadGate = new Promise<void>((r) => {
      resolveGate = r;
    });
    // Subscribe so we can assert currentTrackId at the loading
    // snapshot — getSnapshot()-then-poll is racy on microtask timing.
    const trackIdsByPhase: Record<string, string | null> = {};
    player.subscribe((s) => {
      trackIdsByPhase[s.phase] = s.currentTrackId;
    });
    const playPromise = player.play(localTrack("a"));
    while (!("loading" in trackIdsByPhase)) await Promise.resolve();
    expect(trackIdsByPhase.loading).toBe("a");
    resolveGate();
    await playPromise;
    html.emit({ kind: "playing" });
    expect(player.getSnapshot().currentTrackId).toBe("a");
    html.emit({ kind: "paused" });
    expect(player.getSnapshot().currentTrackId).toBe("a");
  });

  it("ended event keeps target installed so the toolbar can offer replay", async () => {
    await player.play(localTrack("a"));
    html.emit({ kind: "playing" });
    html.emit({ kind: "ended" });
    const s = player.getSnapshot();
    expect(s.currentTrackId).toBe("a");
    expect(s.phase).toBe("paused");
    expect(s.positionMs).toBe(0);
  });

  it("currentTrackId is null only after stop() drains", async () => {
    await player.play(localTrack("a"));
    html.emit({ kind: "playing" });
    await player.stop();
    expect(player.getSnapshot().currentTrackId).toBeNull();
  });

  it("a backend `error` event rolls the player back to idle", async () => {
    await player.play(localTrack("a"));
    html.emit({ kind: "playing" });
    html.emit({ kind: "error", message: "decode failed" });
    await drain();
    expect(errors).toContain("decode failed");
    expect(player.getSnapshot().currentTrackId).toBeNull();
  });
});

// ─── 4. Toggle pause/resume ──────────────────────────────────────────

describe("Player — pause/resume on current target", () => {
  it("play() on the current target pauses, then play() again resumes", async () => {
    await player.play(localTrack("a"));
    html.emit({ kind: "playing" });
    await player.play(localTrack("a"));
    expect(html.calls).toContainEqual({ kind: "pause" });
    html.emit({ kind: "paused" });
    await player.play(localTrack("a"));
    expect(html.calls).toContainEqual({ kind: "resume" });
  });

  it("togglePause(id) only toggles if id matches current — stale callbacks no-op", async () => {
    await player.play(localTrack("a"));
    html.emit({ kind: "playing" });
    html.calls.length = 0;
    await player.togglePause("not-current");
    expect(html.calls).toEqual([]);
    await player.togglePause("a");
    expect(html.calls).toContainEqual({ kind: "pause" });
  });
});

// ─── 5. stop() and stopIfCandidate() ─────────────────────────────────

describe("Player — stop variants", () => {
  it("stop() is idempotent — calling it when idle is a no-op for state", async () => {
    await player.stop();
    expect(player.getSnapshot().phase).toBe("idle");
    expect(player.getSnapshot().currentTrackId).toBeNull();
  });

  it("stop() while playing stops both backends defensively", async () => {
    await player.play(sdkTrack("x"));
    sdk.emit({ kind: "playing" });
    await player.stop();
    expect(sdk.calls).toContainEqual({ kind: "stop" });
    // html backend is also stopped because the SDK could have drifted.
    expect(html.calls).toContainEqual({ kind: "stop" });
    expect(player.getSnapshot().currentTrackId).toBeNull();
  });

  it("stopIfCandidate() does NOT stop main-view track playback", async () => {
    await player.play(localTrack("main")); // kind: "track"
    html.emit({ kind: "playing" });
    html.calls.length = 0;
    await player.stopIfCandidate();
    expect(html.calls).toEqual([]);
    expect(player.getSnapshot().currentTrackId).toBe("main");
  });

  it("stopIfCandidate() stops candidate playback", async () => {
    await player.play(sdkCandidate("spotify:track:x"));
    sdk.emit({ kind: "playing" });
    await player.stopIfCandidate();
    expect(player.getSnapshot().currentTrackId).toBeNull();
  });

  it("stopIfCandidate enqueued AFTER an in-flight candidate play still catches it", async () => {
    // Hold the load() promise so the play stays in flight.
    let resolveGate: () => void = () => undefined;
    sdk.loadGate = new Promise<void>((r) => {
      resolveGate = r;
    });
    const playPromise = player.play(sdkCandidate("spotify:track:x"));
    // Enqueue stop BEFORE the play lands.
    const stopPromise = player.stopIfCandidate();
    // Now let the play finish.
    resolveGate();
    sdk.emit({ kind: "playing" });
    await playPromise;
    await stopPromise;
    // The play landed as candidate, the stop ran AFTER and cleared.
    expect(player.getSnapshot().currentTrackId).toBeNull();
  });
});

// ─── 6. Operation serialization (I3) ─────────────────────────────────

describe("Player — operation queue serializes (I3)", () => {
  it("two concurrent play() calls don't interleave their backend mutations", async () => {
    // Hold the first load so the queue can't drain past A's install.
    let resolveA: () => void = () => undefined;
    html.loadGate = new Promise<void>((r) => {
      resolveA = r;
    });
    const playA = player.play(localTrack("a"));
    // Enqueue B immediately.
    const playB = player.play(localTrack("b"));
    // Yield enough microtasks for A's install to reach its load() call
    // but no further (load is gated).
    for (let i = 0; i < 10; i++) await Promise.resolve();
    const loadsBeforeRelease = html.calls.filter((c) => c.kind === "load");
    expect(loadsBeforeRelease).toHaveLength(1);
    resolveA();
    await playA;
    await playB;
    const loads = html.calls.filter((c) => c.kind === "load");
    expect(loads).toEqual([
      { kind: "load", source: localTrack("a").source },
      { kind: "load", source: localTrack("b").source },
    ]);
  });

  it("a play() that throws via load failure doesn't poison subsequent ops", async () => {
    html.loadResult = false; // first play will fail
    await player.play(localTrack("a"));
    expect(player.getSnapshot().currentTrackId).toBeNull();
    html.loadResult = true;
    await player.play(localTrack("b"));
    html.emit({ kind: "playing" });
    expect(player.getSnapshot().currentTrackId).toBe("b");
  });
});

// ─── 7. Backend selection ────────────────────────────────────────────

describe("Player — backend selection", () => {
  it("local source routes to HTMLAudio without calling sdkLoader", async () => {
    await player.play(localTrack("a"));
    expect(sdkLoader).not.toHaveBeenCalled();
    expect(html.calls).toContainEqual({
      kind: "load",
      source: localTrack("a").source,
    });
  });

  it("spotify-preview routes to HTMLAudio without calling sdkLoader", async () => {
    await player.play(previewCandidate("spotify:track:x", "https://p/x.mp3"));
    expect(sdkLoader).not.toHaveBeenCalled();
    expect(html.calls).toContainEqual({
      kind: "load",
      source: previewCandidate("spotify:track:x", "https://p/x.mp3").source,
    });
  });

  it("spotify-sdk source loads the SDK backend lazily, exactly once", async () => {
    await player.play(sdkTrack("x"));
    expect(sdkLoader).toHaveBeenCalledTimes(1);
    await player.play(sdkTrack("y"));
    expect(sdkLoader).toHaveBeenCalledTimes(1); // cached
  });

  it("when sdkLoader returns null, the player stays idle (no target leak)", async () => {
    sdkLoader.mockResolvedValueOnce(null);
    await player.play(sdkTrack("x"));
    expect(player.getSnapshot().phase).toBe("idle");
    expect(player.getSnapshot().currentTrackId).toBeNull();
  });

  it("after sdkLoader returns null, it is NOT called again (cached failure)", async () => {
    sdkLoader.mockResolvedValueOnce(null);
    await player.play(sdkTrack("x"));
    await player.play(sdkTrack("y"));
    expect(sdkLoader).toHaveBeenCalledTimes(1);
  });
});

// ─── 8. Position / duration mirror ───────────────────────────────────

describe("Player — position + duration are mirrored from backend events", () => {
  it("position events update positionMs and durationMs", async () => {
    await player.play(localTrack("a"));
    html.emit({ kind: "playing" });
    html.emit({ kind: "position", positionMs: 5000, durationMs: 200_000 });
    expect(player.getSnapshot().positionMs).toBe(5000);
    expect(player.getSnapshot().durationMs).toBe(200_000);
  });

  it("a zero durationMs in a position event does not overwrite a known duration", async () => {
    await player.play(localTrack("a"));
    html.emit({ kind: "playing" });
    html.emit({ kind: "position", positionMs: 0, durationMs: 180_000 });
    html.emit({ kind: "position", positionMs: 1000, durationMs: 0 });
    expect(player.getSnapshot().durationMs).toBe(180_000);
  });

  it("seek clamps to [0, durationMs] when duration is known", async () => {
    await player.play(localTrack("a"));
    html.emit({ kind: "playing" });
    html.emit({ kind: "position", positionMs: 0, durationMs: 100_000 });
    await player.seek(50_000);
    expect(html.calls).toContainEqual({ kind: "seek", positionMs: 50_000 });
    await player.seek(999_999_999);
    expect(html.calls).toContainEqual({ kind: "seek", positionMs: 100_000 });
    await player.seek(-1234);
    expect(html.calls).toContainEqual({ kind: "seek", positionMs: 0 });
  });
});

// ─── 9. Subscriptions ────────────────────────────────────────────────

describe("Player — subscriptions", () => {
  it("subscribe fires on every state transition; unsubscribe stops fires", async () => {
    const fn = vi.fn();
    const unsub = player.subscribe(fn);
    await player.play(localTrack("a"));
    html.emit({ kind: "playing" });
    expect(fn.mock.calls.length).toBeGreaterThan(0);
    const before = fn.mock.calls.length;
    unsub();
    await player.stop();
    expect(fn.mock.calls.length).toBe(before);
  });
});
