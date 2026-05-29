// Tests for SpotifySdkBackend — the Backend that wraps the Spotify Web
// Playback SDK player. The backend's job is to translate the SDK's event
// API + getCurrentState() polling into the Player's BackendEvent stream
// without leaking listeners, pollers, or stale "paused" events past a
// stop().
//
// The SDK module (`../spotify/spotifyPlayer`) is mocked end-to-end so we
// can assert exact call shapes for play/pause/resume/seek without a real
// Spotify Connect device. The SDK's player instance is a hand-rolled
// fake matching the SpotifyPlayerInstance shape declared in that module.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BackendEvent, BackendObserver } from "./player";
import type {
  SpotifyPlayerInstance,
  SpotifyPlayerListener,
  SpotifyPlayerSdkState,
} from "../spotify/spotifyPlayer";

vi.mock("../spotify/spotifyPlayer", () => ({
  pauseSpotifyPlayback: vi.fn(async () => undefined),
  resumeSpotifyPlayback: vi.fn(async () => undefined),
  playSpotifyTrackOnDevice: vi.fn(async () => undefined),
  seekSpotifyPlayback: vi.fn(async () => undefined),
}));

// Import AFTER vi.mock so the SUT receives the mocked module.
import { SpotifySdkBackend } from "./spotifySdkBackend";
import {
  pauseSpotifyPlayback,
  playSpotifyTrackOnDevice,
  resumeSpotifyPlayback,
  seekSpotifyPlayback,
} from "../spotify/spotifyPlayer";

// ─── Fake SDK player instance ────────────────────────────────────────
//
// Matches the SpotifyPlayerInstance shape exported by spotifyPlayer.ts.
// Listeners are stored per-event so tests can synthesize SDK state
// changes by calling `fireStateChanged()`. `getCurrentState` is a vi.fn
// so tests can stub per-poll responses.

type FakePlayer = SpotifyPlayerInstance & {
  listenersFor: (event: string) => SpotifyPlayerListener[];
  fireStateChanged: (state: SpotifyPlayerSdkState | null) => void;
  getCurrentState: ReturnType<typeof vi.fn>;
};

function makeFakePlayer(): FakePlayer {
  const listeners = new Map<string, Set<SpotifyPlayerListener>>();
  const getCurrentState = vi.fn(async () => null as SpotifyPlayerSdkState | null);
  const player: FakePlayer = {
    connect: vi.fn(async () => true),
    disconnect: vi.fn(),
    addListener: vi.fn((event: string, cb: SpotifyPlayerListener) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(cb);
      return true;
    }),
    removeListener: vi.fn((event: string, cb?: SpotifyPlayerListener) => {
      const set = listeners.get(event);
      if (!set) return false;
      if (cb) set.delete(cb);
      else set.clear();
      return true;
    }),
    pause: vi.fn(async () => undefined),
    resume: vi.fn(async () => undefined),
    seek: vi.fn(async () => undefined),
    getCurrentState,
    listenersFor: (event: string) => Array.from(listeners.get(event) ?? []),
    fireStateChanged: (state: SpotifyPlayerSdkState | null) => {
      const set = listeners.get("player_state_changed");
      if (!set) return;
      for (const cb of set) cb(state);
    },
  };
  return player;
}

// ─── Setup ───────────────────────────────────────────────────────────

let player: FakePlayer;
let backend: SpotifySdkBackend;
let events: BackendEvent[];
let observer: BackendObserver;

beforeEach(() => {
  vi.clearAllMocks();
  player = makeFakePlayer();
  backend = new SpotifySdkBackend({
    player,
    deviceId: "dev-1",
    clientId: "client-1",
  });
  events = [];
  observer = (e) => events.push(e);
  backend.setObserver(observer);
});

afterEach(() => {
  vi.useRealTimers();
});

// ─── 1. load() ────────────────────────────────────────────────────────

describe("SpotifySdkBackend — load()", () => {
  it("returns false (and does NOT call playSpotifyTrackOnDevice) for a non-SDK source", async () => {
    // The backend is a single-kind device — only spotify-sdk sources
    // are its responsibility. The Player asks each backend in turn;
    // a non-SDK source must be declined cleanly without touching the
    // Spotify API or attaching any listeners.
    const ok = await backend.load({
      kind: "local",
      objectUrl: "blob://x",
      label: "Local file",
    });
    expect(ok).toBe(false);
    expect(playSpotifyTrackOnDevice).not.toHaveBeenCalled();
    expect(player.addListener).not.toHaveBeenCalled();
  });

  it("on success: calls playSpotifyTrackOnDevice with (uri, deviceId, clientId), attaches the state listener, and returns true", async () => {
    const ok = await backend.load({
      kind: "spotify-sdk",
      uri: "spotify:track:abc",
      label: "Spotify (full track)",
    });
    expect(ok).toBe(true);
    expect(playSpotifyTrackOnDevice).toHaveBeenCalledWith(
      "spotify:track:abc",
      "dev-1",
      "client-1",
    );
    // Exactly one listener attached on player_state_changed.
    expect(player.listenersFor("player_state_changed")).toHaveLength(1);
  });

  it("on failure: emits a {kind:'error'} event prefixed 'Spotify SDK:' and returns false", async () => {
    vi.mocked(playSpotifyTrackOnDevice).mockRejectedValueOnce(
      new Error("403 forbidden"),
    );
    const ok = await backend.load({
      kind: "spotify-sdk",
      uri: "spotify:track:abc",
      label: "Spotify (full track)",
    });
    expect(ok).toBe(false);
    expect(events).toContainEqual({
      kind: "error",
      message: "Spotify SDK: 403 forbidden",
    });
    // No listener should have been attached on the failure path.
    expect(player.listenersFor("player_state_changed")).toHaveLength(0);
  });

  it("on failure with a non-Error throw: emits 'unknown SDK error' rather than the raw value", async () => {
    // Defensive: callSpotify could in principle throw something exotic.
    // The backend must coerce to a stable message string instead of
    // interpolating an object/string into the error event.
    vi.mocked(playSpotifyTrackOnDevice).mockRejectedValueOnce("weird");
    const ok = await backend.load({
      kind: "spotify-sdk",
      uri: "spotify:track:abc",
      label: "Spotify (full track)",
    });
    expect(ok).toBe(false);
    expect(events).toContainEqual({
      kind: "error",
      message: "Spotify SDK: unknown SDK error",
    });
  });
});

// ─── 2. stop() ────────────────────────────────────────────────────────

describe("SpotifySdkBackend — stop()", () => {
  it("detaches the SDK state listener AND calls pauseSpotifyPlayback", async () => {
    await backend.load({
      kind: "spotify-sdk",
      uri: "spotify:track:abc",
      label: "Spotify (full track)",
    });
    expect(player.listenersFor("player_state_changed")).toHaveLength(1);
    await backend.stop();
    expect(player.listenersFor("player_state_changed")).toHaveLength(0);
    expect(pauseSpotifyPlayback).toHaveBeenCalledWith(player);
  });

  it("REGRESSION: a state event fired AFTER stop() does not leak a stale 'paused' into the observer", async () => {
    // The contract: once the Player has called stop(), the SDK might
    // still fire a final player_state_changed for the pause. If that
    // bled through, the Player would receive a "paused" event for a
    // backend it's already moved on from, corrupting the snapshot.
    // Detaching the listener inside stop() prevents the leak.
    await backend.load({
      kind: "spotify-sdk",
      uri: "spotify:track:abc",
      label: "Spotify (full track)",
    });
    await backend.stop();
    events.length = 0;
    // The SDK belatedly fires its paused state. The backend has already
    // detached, so this is a no-op for our listener bookkeeping AND for
    // the observer.
    player.fireStateChanged({ paused: true, position: 0, duration: 1000 });
    expect(events).toEqual([]);
  });

  it("swallows a pauseSpotifyPlayback rejection via console.warn", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.mocked(pauseSpotifyPlayback).mockRejectedValueOnce(new Error("boom"));
    await backend.load({
      kind: "spotify-sdk",
      uri: "spotify:track:abc",
      label: "Spotify (full track)",
    });
    // stop() must resolve, not reject, even when pause throws.
    await expect(backend.stop()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("is safe to call when no load() has happened (no listener / poller to detach)", async () => {
    // The Player calls stop() defensively on cross-backend transitions
    // even when the backend has never played anything. Must not throw,
    // must still call through to pauseSpotifyPlayback.
    await expect(backend.stop()).resolves.toBeUndefined();
    expect(pauseSpotifyPlayback).toHaveBeenCalledWith(player);
  });
});

// ─── 3. Polling cycle ────────────────────────────────────────────────

describe("SpotifySdkBackend — 500ms polling cycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("after load(): polls getCurrentState every 500ms and translates the result into observer events", async () => {
    // Pre-stage the getCurrentState response so the first poll tick
    // returns a known state. We can then advance fake timers to flush
    // the interval callback and assert the translated events.
    player.getCurrentState.mockResolvedValue({
      paused: false,
      position: 12_345,
      duration: 234_000,
    } satisfies SpotifyPlayerSdkState);
    await backend.load({
      kind: "spotify-sdk",
      uri: "spotify:track:abc",
      label: "Spotify (full track)",
    });
    expect(player.getCurrentState).not.toHaveBeenCalled();
    // Advance one poll cycle. The interval fires the callback, which
    // calls getCurrentState() and awaits its result before emitting.
    await vi.advanceTimersByTimeAsync(500);
    expect(player.getCurrentState).toHaveBeenCalledTimes(1);
    expect(events).toContainEqual({
      kind: "position",
      positionMs: 12_345,
      durationMs: 234_000,
    });
    expect(events).toContainEqual({ kind: "playing" });
  });

  it("a paused state from the poll emits {kind:'paused'} (not 'playing')", async () => {
    player.getCurrentState.mockResolvedValue({
      paused: true,
      position: 8_000,
      duration: 234_000,
    } satisfies SpotifyPlayerSdkState);
    await backend.load({
      kind: "spotify-sdk",
      uri: "spotify:track:abc",
      label: "Spotify (full track)",
    });
    await vi.advanceTimersByTimeAsync(500);
    expect(events).toContainEqual({ kind: "paused" });
    expect(events).not.toContainEqual({ kind: "playing" });
  });

  it("stop() halts the poll: no further getCurrentState calls after stop", async () => {
    player.getCurrentState.mockResolvedValue({
      paused: false,
      position: 0,
      duration: 1000,
    } satisfies SpotifyPlayerSdkState);
    await backend.load({
      kind: "spotify-sdk",
      uri: "spotify:track:abc",
      label: "Spotify (full track)",
    });
    await vi.advanceTimersByTimeAsync(500);
    const callsAfterFirstTick = player.getCurrentState.mock.calls.length;
    await backend.stop();
    // Advance well past several poll windows.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(player.getCurrentState.mock.calls.length).toBe(callsAfterFirstTick);
  });

  it("a getCurrentState rejection is swallowed silently (no observer error event)", async () => {
    // The comment in startPoller says rejection happens when the device
    // is no longer active and we don't want to spam errors — the SDK
    // event listener handles real state changes.
    player.getCurrentState.mockRejectedValue(new Error("device-gone"));
    await backend.load({
      kind: "spotify-sdk",
      uri: "spotify:track:abc",
      label: "Spotify (full track)",
    });
    await vi.advanceTimersByTimeAsync(500);
    // No error event should reach the observer for a poll failure.
    expect(events.filter((e) => e.kind === "error")).toEqual([]);
  });
});

// ─── 4. State translation (applyState via SDK listener) ──────────────

describe("SpotifySdkBackend — applyState translation", () => {
  it("the SDK's player_state_changed listener emits position + playing/paused on a non-null state", async () => {
    await backend.load({
      kind: "spotify-sdk",
      uri: "spotify:track:abc",
      label: "Spotify (full track)",
    });
    player.fireStateChanged({
      paused: false,
      position: 1_000,
      duration: 30_000,
    });
    expect(events).toEqual([
      { kind: "position", positionMs: 1_000, durationMs: 30_000 },
      { kind: "playing" },
    ]);
  });

  it("a null SDK state is a no-op (no events emitted)", async () => {
    // The SDK reports null when no track is current on the device.
    // The backend must NOT translate that into a position(0,0) +
    // paused — that would clobber the Player's last-known good state.
    await backend.load({
      kind: "spotify-sdk",
      uri: "spotify:track:abc",
      label: "Spotify (full track)",
    });
    player.fireStateChanged(null);
    expect(events).toEqual([]);
  });

  it("a paused: true state emits position + paused (in that order)", async () => {
    await backend.load({
      kind: "spotify-sdk",
      uri: "spotify:track:abc",
      label: "Spotify (full track)",
    });
    player.fireStateChanged({
      paused: true,
      position: 5_555,
      duration: 30_000,
    });
    expect(events).toEqual([
      { kind: "position", positionMs: 5_555, durationMs: 30_000 },
      { kind: "paused" },
    ]);
  });

  it("with no observer attached, applyState is a silent no-op", async () => {
    // setObserver(null) is the contract when the backend is idle. A
    // late-arriving SDK event must not throw or attempt to call a null
    // observer.
    await backend.load({
      kind: "spotify-sdk",
      uri: "spotify:track:abc",
      label: "Spotify (full track)",
    });
    backend.setObserver(null);
    expect(() =>
      player.fireStateChanged({ paused: false, position: 1, duration: 2 }),
    ).not.toThrow();
  });
});

// ─── 5. pause / resume / seek pass-through + error swallowing ───────

describe("SpotifySdkBackend — pause / resume / seek", () => {
  it("pause() calls pauseSpotifyPlayback with the player instance", async () => {
    await backend.pause();
    expect(pauseSpotifyPlayback).toHaveBeenCalledWith(player);
  });

  it("resume() calls resumeSpotifyPlayback with the player instance", async () => {
    await backend.resume();
    expect(resumeSpotifyPlayback).toHaveBeenCalledWith(player);
  });

  it("seek() calls seekSpotifyPlayback with the player instance and positionMs", async () => {
    await backend.seek(42_000);
    expect(seekSpotifyPlayback).toHaveBeenCalledWith(player, 42_000);
  });

  it("pause() rejection is swallowed via console.warn", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.mocked(pauseSpotifyPlayback).mockRejectedValueOnce(new Error("nope"));
    await expect(backend.pause()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("resume() rejection is swallowed via console.warn", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.mocked(resumeSpotifyPlayback).mockRejectedValueOnce(new Error("nope"));
    await expect(backend.resume()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("seek() rejection is swallowed via console.warn", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.mocked(seekSpotifyPlayback).mockRejectedValueOnce(new Error("nope"));
    await expect(backend.seek(100)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
