// @vitest-environment happy-dom
//
// Tests for the Spotify Web Playback SDK wrapper. The headline contracts:
//
//   C1. Concurrent `initializeSpotifyPlayer` calls share ONE in-flight init
//       promise — without this, every caller would spawn a duplicate
//       Spotify Connect device and burn a WebSocket connection apiece.
//   C2. The Promise wrapping the SDK init fan-out resolves AT MOST ONCE
//       (`settled` guard). The SDK can fire `ready` + `*_error` events
//       in overlapping order; only the first wins.
//   C3. SDK_INIT_TIMEOUT_MS (10s) — a hung SDK (CSP block, EME failure)
//       must surface as `ok: false` instead of pinning playback in
//       "loading" forever.
//   C4. Post-init `playback_error` / `not_ready` events route through
//       handlers supplied at init time.
//   C5. `pauseSpotifyPlayback` / `resumeSpotifyPlayback` /
//       `seekSpotifyPlayback` call through to the SDK instance.
//
// We stub `window.Spotify` directly so no real <script> tag has to load.
// `loadSdk` short-circuits when `window.Spotify` is already set on entry.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the apiClient + authFlow modules — spotifyPlayer imports them at
// module scope, and we don't want real fetch / token storage in tests.
vi.mock("./apiClient", () => ({
  callSpotify: vi.fn(async () => undefined),
}));
vi.mock("./authFlow", () => ({
  getValidAccessToken: vi.fn(async () => "fake-token"),
}));

import { callSpotify } from "./apiClient";
import {
  destroySpotifyPlayer,
  initializeSpotifyPlayer,
  pauseSpotifyPlayback,
  playSpotifyTrackOnDevice,
  resumeSpotifyPlayback,
  seekSpotifyPlayback,
} from "./spotifyPlayer";

// ─── Fake SDK player ─────────────────────────────────────────────────

type Listener = (data: unknown) => void;

type ListenerMap = Map<string, Listener[]>;

class FakeSpotifyPlayer {
  readonly options: { name: string; volume?: number };
  readonly listeners: ListenerMap = new Map();
  /** Resolved value of connect(). */
  connectResult: boolean | Promise<boolean> = true;
  /** Set to a rejection to simulate connect() throwing. */
  connectError: Error | null = null;
  pause = vi.fn(async () => undefined);
  resume = vi.fn(async () => undefined);
  seek = vi.fn(async (_positionMs: number) => undefined);
  disconnect = vi.fn(() => undefined);
  getCurrentState = vi.fn(async () => null);

  constructor(options: { name: string; volume?: number }) {
    this.options = options;
  }

  addListener(event: string, cb: Listener): boolean {
    const arr = this.listeners.get(event) ?? [];
    arr.push(cb);
    this.listeners.set(event, arr);
    return true;
  }

  removeListener(event: string, cb?: Listener): boolean {
    if (!cb) {
      this.listeners.delete(event);
      return true;
    }
    const arr = this.listeners.get(event);
    if (!arr) return false;
    this.listeners.set(
      event,
      arr.filter((l) => l !== cb),
    );
    return true;
  }

  connect(): Promise<boolean> {
    if (this.connectError) return Promise.reject(this.connectError);
    return Promise.resolve(this.connectResult);
  }

  /** Test helper — fire an SDK event into every registered listener. */
  fire(event: string, data: unknown): void {
    const arr = this.listeners.get(event);
    if (!arr) return;
    for (const cb of arr.slice()) cb(data);
  }
}

// Track the most recent player instance the SUT constructed so tests
// can drive its listeners. window.Spotify.Player is a constructor — we
// stash the instance on each construction.
let lastPlayer: FakeSpotifyPlayer | null = null;

function installSpotifyGlobal(): void {
  // Setting window.Spotify pre-load makes loadSdk() resolve immediately
  // without ever appending a <script> tag — we sidestep the real CDN.
  (window as unknown as { Spotify: unknown }).Spotify = {
    Player: vi.fn((options: { name: string; volume?: number }) => {
      lastPlayer = new FakeSpotifyPlayer(options);
      return lastPlayer;
    }),
  };
}

function clearSpotifyGlobal(): void {
  delete (window as unknown as { Spotify?: unknown }).Spotify;
  delete (window as unknown as { onSpotifyWebPlaybackSDKReady?: unknown })
    .onSpotifyWebPlaybackSDKReady;
}

// ─── Setup ───────────────────────────────────────────────────────────

beforeEach(async () => {
  vi.clearAllMocks();
  lastPlayer = null;
  installSpotifyGlobal();
  // The SUT caches the active init result/promise at module scope.
  // destroySpotifyPlayer() drops the cache so each test starts clean.
  await destroySpotifyPlayer();
});

afterEach(() => {
  clearSpotifyGlobal();
  vi.useRealTimers();
});

/** Microtask flush helper — yields long enough for the init Promise's
 * .then chain (loadSdk → constructor → addListener registration) to
 * reach the point where SDK events can be fired. */
async function flushMicrotasks(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

// ─── 1. Concurrent init dedup (C1) ───────────────────────────────────

describe("initializeSpotifyPlayer — concurrent-call dedup (C1)", () => {
  it("two concurrent calls share one in-flight init promise — only one Player is constructed", async () => {
    // Kick off two calls before the first resolves. Both must see the
    // same in-flight Promise; otherwise we'd spawn two Connect devices.
    const p1 = initializeSpotifyPlayer("client-id");
    const p2 = initializeSpotifyPlayer("client-id");
    await flushMicrotasks();
    expect(lastPlayer).not.toBeNull();
    // Fire ready ONCE — both promises should resolve from this event.
    lastPlayer!.fire("ready", { device_id: "device-1" });
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    if (r1.ok && r2.ok) {
      // Same player instance — no duplicate device.
      expect(r1.player).toBe(r2.player);
      expect(r1.deviceId).toBe("device-1");
    }
    // Only one Player constructor call.
    const PlayerCtor = (window as unknown as { Spotify: { Player: ReturnType<typeof vi.fn> } })
      .Spotify.Player;
    expect(PlayerCtor).toHaveBeenCalledTimes(1);
  });

  it("a subsequent call after success returns the cached ok result without re-constructing", async () => {
    const p1 = initializeSpotifyPlayer("client-id");
    await flushMicrotasks();
    lastPlayer!.fire("ready", { device_id: "device-1" });
    const r1 = await p1;
    expect(r1.ok).toBe(true);

    // Second call after the first has resolved — must return the
    // cached player/deviceId without invoking the SDK constructor again.
    const r2 = await initializeSpotifyPlayer("client-id");
    expect(r2.ok).toBe(true);
    if (r1.ok && r2.ok) {
      expect(r2.player).toBe(r1.player);
      expect(r2.deviceId).toBe(r1.deviceId);
    }
    const PlayerCtor = (window as unknown as { Spotify: { Player: ReturnType<typeof vi.fn> } })
      .Spotify.Player;
    expect(PlayerCtor).toHaveBeenCalledTimes(1);
  });

  it("after a failed init, a follow-up call retries (cache cleared on ok:false)", async () => {
    // A failure must NOT poison the cache. Users toggling
    // preferFullPlayback off→on must be able to retry.
    const p1 = initializeSpotifyPlayer("client-id");
    await flushMicrotasks();
    lastPlayer!.fire("authentication_error", { message: "bad token" });
    const r1 = await p1;
    expect(r1.ok).toBe(false);

    const p2 = initializeSpotifyPlayer("client-id");
    await flushMicrotasks();
    // A fresh Player must have been constructed (lastPlayer updated).
    const PlayerCtor = (window as unknown as { Spotify: { Player: ReturnType<typeof vi.fn> } })
      .Spotify.Player;
    expect(PlayerCtor).toHaveBeenCalledTimes(2);
    lastPlayer!.fire("ready", { device_id: "device-2" });
    const r2 = await p2;
    expect(r2.ok).toBe(true);
  });

  it("destroySpotifyPlayer drops cache and calls disconnect on the active player", async () => {
    const p1 = initializeSpotifyPlayer("client-id");
    await flushMicrotasks();
    const playerInstance = lastPlayer!;
    playerInstance.fire("ready", { device_id: "device-1" });
    await p1;

    await destroySpotifyPlayer();
    expect(playerInstance.disconnect).toHaveBeenCalledTimes(1);

    // Next init must construct a fresh Player.
    const p2 = initializeSpotifyPlayer("client-id");
    await flushMicrotasks();
    lastPlayer!.fire("ready", { device_id: "device-2" });
    const r2 = await p2;
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.deviceId).toBe("device-2");
  });
});

// ─── 2. settle() once-only guard (C2) ────────────────────────────────

describe("initializeSpotifyPlayer — settle() resolves at most once (C2)", () => {
  it("an `authentication_error` fired AFTER `ready` does not flip the result", async () => {
    // The SDK can fan out overlapping events. The init Promise must
    // latch on the first settle() and ignore everything after.
    const p = initializeSpotifyPlayer("client-id");
    await flushMicrotasks();
    lastPlayer!.fire("ready", { device_id: "device-ok" });
    // Belated error — must be ignored by settle().
    lastPlayer!.fire("authentication_error", { message: "too late" });
    const r = await p;
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.deviceId).toBe("device-ok");
  });

  it("a `ready` fired twice resolves to the first device_id", async () => {
    const p = initializeSpotifyPlayer("client-id");
    await flushMicrotasks();
    lastPlayer!.fire("ready", { device_id: "first" });
    lastPlayer!.fire("ready", { device_id: "second" });
    const r = await p;
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.deviceId).toBe("first");
  });

  it("a `ready` payload missing device_id does NOT settle the promise (waits for a real ready)", async () => {
    // Defensive: an SDK that fires `ready` with no device_id (shouldn't
    // happen, but the SUT guards for it) must keep waiting so a real
    // subsequent ready event can land.
    const p = initializeSpotifyPlayer("client-id");
    await flushMicrotasks();
    lastPlayer!.fire("ready", {}); // no device_id
    lastPlayer!.fire("ready", { device_id: "real" });
    const r = await p;
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.deviceId).toBe("real");
  });

  it("maps account_error to reason: not-premium", async () => {
    const p = initializeSpotifyPlayer("client-id");
    await flushMicrotasks();
    lastPlayer!.fire("account_error", { message: "free tier" });
    const r = await p;
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("not-premium");
      expect(r.message).toBe("free tier");
    }
  });

  it("maps authentication_error to reason: auth", async () => {
    const p = initializeSpotifyPlayer("client-id");
    await flushMicrotasks();
    lastPlayer!.fire("authentication_error", { message: "token expired" });
    const r = await p;
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("auth");
  });

  it("maps initialization_error to reason: unknown", async () => {
    const p = initializeSpotifyPlayer("client-id");
    await flushMicrotasks();
    lastPlayer!.fire("initialization_error", { message: "EME blocked" });
    const r = await p;
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("unknown");
      expect(r.message).toBe("EME blocked");
    }
  });

  it("a synchronous connect() rejection surfaces as ok:false instead of hanging until the 10s timeout", async () => {
    // connect() rejection is the fast-path for "EME unavailable" /
    // "popup blocked" failures. Without the .catch(settle), users
    // wait the full SDK_INIT_TIMEOUT_MS for a generic timeout error
    // instead of the real message.
    const PlayerCtor = (window as unknown as {
      Spotify: { Player: ReturnType<typeof vi.fn> };
    }).Spotify.Player;
    PlayerCtor.mockImplementationOnce((options: { name: string }) => {
      lastPlayer = new FakeSpotifyPlayer(options);
      lastPlayer.connectError = new Error("EME unavailable");
      return lastPlayer;
    });
    const p = initializeSpotifyPlayer("client-id");
    const r = await p;
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("unknown");
      expect(r.message).toBe("EME unavailable");
    }
  });
});

// ─── 3. 10-second SDK init timeout (C3) ──────────────────────────────

describe("initializeSpotifyPlayer — SDK_INIT_TIMEOUT_MS bounds a hung init (C3)", () => {
  it("a never-resolving SDK init yields ok:false after 10 seconds", async () => {
    // Real-world cause: CSP blocks the EME license server, so the SDK
    // never fires `ready` OR an error event. Without the timeout,
    // playback would pin on "loading" forever.
    vi.useFakeTimers();
    const p = initializeSpotifyPlayer("client-id");
    // Let the init Promise body run (loadSdk → constructor → connect)
    // without firing any SDK event.
    await vi.advanceTimersByTimeAsync(0);
    // 9.999s — still hung.
    await vi.advanceTimersByTimeAsync(9_999);
    // No resolution yet — we can't easily assert "promise hasn't
    // resolved" directly, but advancing past the boundary will:
    await vi.advanceTimersByTimeAsync(2);
    const r = await p;
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("unknown");
      // Message references the 10-second budget (derived from
      // SDK_INIT_TIMEOUT_MS / 1000) so users get a recognizable hint.
      expect(r.message).toMatch(/10s|10 ?s|10 seconds/);
    }
  });

  it("a `ready` event before the timeout cancels the timer (resolution beats the timeout)", async () => {
    vi.useFakeTimers();
    const p = initializeSpotifyPlayer("client-id");
    await vi.advanceTimersByTimeAsync(0);
    // Fire ready well within the timeout window.
    await vi.advanceTimersByTimeAsync(500);
    lastPlayer!.fire("ready", { device_id: "fast" });
    // Advance past the timeout boundary — the cleared timer must NOT
    // fire a second settle() that overrides the success.
    await vi.advanceTimersByTimeAsync(60_000);
    const r = await p;
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.deviceId).toBe("fast");
  });
});

// ─── 4. Post-init listener routing (C4) ──────────────────────────────

describe("initializeSpotifyPlayer — routes post-init events through injected handlers (C4)", () => {
  it("playback_error fires onError with the SDK-provided message", async () => {
    const errors: string[] = [];
    const p = initializeSpotifyPlayer("client-id", {
      onError: (m) => errors.push(m),
    });
    await flushMicrotasks();
    lastPlayer!.fire("ready", { device_id: "d" });
    await p;
    // Fire a playback_error AFTER init — these are post-init events
    // (DRM hiccup, codec failure) and route through the error handler.
    lastPlayer!.fire("playback_error", { message: "DRM failed" });
    expect(errors).toEqual(["DRM failed"]);
  });

  it("playback_error with no message falls back to 'playback failed'", async () => {
    const errors: string[] = [];
    const p = initializeSpotifyPlayer("client-id", {
      onError: (m) => errors.push(m),
    });
    await flushMicrotasks();
    lastPlayer!.fire("ready", { device_id: "d" });
    await p;
    lastPlayer!.fire("playback_error", {});
    expect(errors).toEqual(["playback failed"]);
  });

  it("not_ready fires onNotReady so the store can reset to idle", async () => {
    // Real-world trigger: the device gets handed off to another tab,
    // or the laptop sleeps. The store needs to know so it stops
    // issuing play commands against a dead device id.
    const notReady = vi.fn();
    const p = initializeSpotifyPlayer("client-id", { onNotReady: notReady });
    await flushMicrotasks();
    lastPlayer!.fire("ready", { device_id: "d" });
    await p;
    lastPlayer!.fire("not_ready", { device_id: "d" });
    expect(notReady).toHaveBeenCalledTimes(1);
  });

  it("init without handlers means post-init events are silently dropped", async () => {
    // The handlers arg defaults to {} — the listener callbacks use
    // optional-chaining so missing handlers no-op cleanly.
    const p = initializeSpotifyPlayer("client-id");
    await flushMicrotasks();
    lastPlayer!.fire("ready", { device_id: "d" });
    await p;
    expect(() =>
      lastPlayer!.fire("playback_error", { message: "boom" }),
    ).not.toThrow();
    expect(() =>
      lastPlayer!.fire("not_ready", { device_id: "d" }),
    ).not.toThrow();
  });
});

// ─── 5. Pause / resume / seek call-through (C5) ──────────────────────

describe("pauseSpotifyPlayback / resumeSpotifyPlayback / seekSpotifyPlayback", () => {
  it("pauseSpotifyPlayback calls player.pause()", async () => {
    const p = initializeSpotifyPlayer("client-id");
    await flushMicrotasks();
    lastPlayer!.fire("ready", { device_id: "d" });
    const r = await p;
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    await pauseSpotifyPlayback(r.player);
    expect(lastPlayer!.pause).toHaveBeenCalledTimes(1);
  });

  it("resumeSpotifyPlayback calls player.resume()", async () => {
    const p = initializeSpotifyPlayer("client-id");
    await flushMicrotasks();
    lastPlayer!.fire("ready", { device_id: "d" });
    const r = await p;
    if (!r.ok) throw new Error("expected ok");
    await resumeSpotifyPlayback(r.player);
    expect(lastPlayer!.resume).toHaveBeenCalledTimes(1);
  });

  it("seekSpotifyPlayback floors and clamps to a non-negative integer", async () => {
    // Spotify's SDK takes an integer; the SUT does
    // `Math.max(0, Math.floor(positionMs))` so a float or negative
    // input doesn't tunnel through to the SDK.
    const p = initializeSpotifyPlayer("client-id");
    await flushMicrotasks();
    lastPlayer!.fire("ready", { device_id: "d" });
    const r = await p;
    if (!r.ok) throw new Error("expected ok");

    await seekSpotifyPlayback(r.player, 1234.7);
    expect(lastPlayer!.seek).toHaveBeenLastCalledWith(1234);

    await seekSpotifyPlayback(r.player, -50);
    expect(lastPlayer!.seek).toHaveBeenLastCalledWith(0);

    await seekSpotifyPlayback(r.player, 0);
    expect(lastPlayer!.seek).toHaveBeenLastCalledWith(0);
  });
});

// ─── 6. playSpotifyTrackOnDevice ─────────────────────────────────────

describe("playSpotifyTrackOnDevice", () => {
  it("PUTs /me/player/play with the device id query and the uri in the body", async () => {
    // Sanity check on the REST shim — the deviceId belongs in the
    // query string (Spotify's Connect API contract); the uri is wrapped
    // in a `uris` array body.
    await playSpotifyTrackOnDevice(
      "spotify:track:abc",
      "device-1",
      "client-id",
    );
    expect(callSpotify).toHaveBeenCalledTimes(1);
    expect(callSpotify).toHaveBeenCalledWith(
      {
        path: "/me/player/play",
        method: "PUT",
        query: { device_id: "device-1" },
        body: { uris: ["spotify:track:abc"] },
      },
      "client-id",
    );
  });
});
