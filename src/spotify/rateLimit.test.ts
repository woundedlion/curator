// Comprehensive mock-fetch coverage of the Spotify rate-limit policy.
//
// The user incident this targets: a 429 with a CORS-hidden Retry-After
// header (~23h penalty on the wire) triggered the in-call retry loop,
// which fired three more requests into the active ban window and
// compounded the penalty to ~a full day. The rewritten policy is
// single-shot per submission and lets the circuit breaker drive
// recovery — these tests exercise every transition of the state
// machine so a regression can't reach the user again.
//
// Scenarios covered:
//   - fresh load (no persisted state, first request fires immediately)
//   - fresh load WITH persisted nextAllowedAt / circuitOpenUntil
//   - "global refresh" pattern: N concurrent callers space at 350ms
//   - "global refresh" pattern: 429 mid-batch opens the circuit and
//     every subsequent caller fails fast (no compounding)
//   - "manual item refresh" pattern: one call, respects open circuit
//   - circuit-breaker half-open: exactly one probe is admitted
//   - probe success closes the circuit
//   - probe 429 reopens for the new window
//   - Retry-After missing → 5-minute default (was 30s — caused
//     immediate retry into multi-hour bans)
//   - localStorage persistence across module reload
//   - pendingCount surfaces queued callers for the UI

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// localStorage polyfill — must be in place before apiClient.ts loads.
// vitest's node environment doesn't provide one.
class MemoryStorage implements Storage {
  private store = new Map<string, string>();
  get length(): number {
    return this.store.size;
  }
  clear(): void {
    this.store.clear();
  }
  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }
  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null;
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
}

vi.stubGlobal("localStorage", new MemoryStorage());

// Stub the dynamic import of useUiStore inside pushRateLimitToast so
// the toast machinery doesn't try to pull in the whole zustand UI
// store under the node environment.
vi.mock("../store/uiStore", () => ({
  useUiStore: {
    getState: () => ({ pushToast: () => undefined }),
  },
}));

import {
  __getSpotifyRateLimitStateForTests,
  __resetSpotifyRateLimitStateForTests,
  getPendingSpotifyRequestCount,
  resetSpotifyCircuit,
  spotifyCircuitOpenMs,
  SpotifyRateLimitError,
  submitTokenRequest,
} from "./apiClient";
import {
  SPOTIFY_CIRCUIT_OPEN_UNTIL_KEY,
  SPOTIFY_NEXT_ALLOWED_AT_KEY,
} from "../constants";

const MIN_SPACING_MS = 350;

function ok(): Response {
  return new Response(null, { status: 200 });
}

function tooMany(retryAfter: string | null = null): Response {
  const headers = new Headers();
  if (retryAfter !== null) headers.set("Retry-After", retryAfter);
  return new Response(null, { status: 429, headers });
}

// Sink for promise rejections we know about. Promise.allSettled in the
// test body doesn't catch synchronous rejection from a fail-fast
// breaker path before the test awaits — vitest's "unhandledRejection"
// hook makes those fatal. Attaching .catch() makes them handled.
function settle(p: Promise<unknown>): Promise<unknown> {
  return p.catch(() => undefined);
}

// Capture a promise's rejection synchronously (before any await) so
// advancing fake timers can't trigger an "unhandled rejection" error.
// The returned promise resolves with the rejection reason; callers
// assert on it after advancing time. This is the safe replacement
// for `await expect(p).rejects.toBeInstanceOf(...)` in fake-timer
// tests where the rejection fires between promise creation and the
// expect attaching its catch.
function captureRejection<T>(p: Promise<T>): Promise<unknown> {
  return p.then(
    () => new Error("expected rejection but promise resolved"),
    (reason) => reason,
  );
}

beforeEach(() => {
  __resetSpotifyRateLimitStateForTests();
  localStorage.clear();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("fresh load", () => {
  it("first request after a clean load fires immediately (no wait)", async () => {
    const sendTimestamps: number[] = [];
    const send = vi.fn(async () => {
      sendTimestamps.push(Date.now());
      return ok();
    });

    const startedAt = Date.now();
    const p = submitTokenRequest(send, "/me");
    await vi.advanceTimersByTimeAsync(0);

    expect(send).toHaveBeenCalledTimes(1);
    expect(sendTimestamps[0]).toBe(startedAt);
    await p;
  });

  it("a single call advances nextAllowedAt by MIN_SPACING for the next caller", async () => {
    const send = vi.fn(async () => ok());
    const startedAt = Date.now();
    const p = submitTokenRequest(send, "/me");
    await vi.advanceTimersByTimeAsync(0);
    await p;

    expect(__getSpotifyRateLimitStateForTests().nextAllowedAt).toBe(
      startedAt + MIN_SPACING_MS,
    );
  });

  it("restores persisted nextAllowedAt across module reload", async () => {
    const future = Date.now() + 5000;
    localStorage.setItem(SPOTIFY_NEXT_ALLOWED_AT_KEY, String(future));
    vi.resetModules();
    const fresh = await import("./apiClient");
    expect(fresh.__getSpotifyRateLimitStateForTests().nextAllowedAt).toBe(
      future,
    );
  });

  it("restores persisted circuitOpenUntil across module reload — fails fast immediately", async () => {
    const future = Date.now() + 10_000;
    localStorage.setItem(SPOTIFY_CIRCUIT_OPEN_UNTIL_KEY, String(future));
    vi.resetModules();
    const fresh = await import("./apiClient");

    const send = vi.fn(async () => ok());
    await expect(
      fresh.submitTokenRequest(send, "/me"),
    ).rejects.toBeInstanceOf(fresh.SpotifyRateLimitError);
    expect(send).not.toHaveBeenCalled();
  });

  it("ignores a persisted nextAllowedAt that's already in the past", async () => {
    const past = Date.now() - 5000;
    localStorage.setItem(SPOTIFY_NEXT_ALLOWED_AT_KEY, String(past));
    vi.resetModules();
    const fresh = await import("./apiClient");
    expect(fresh.__getSpotifyRateLimitStateForTests().nextAllowedAt).toBe(0);
  });

  it("caps a wildly-future persisted nextAllowedAt at 60s", async () => {
    const farFuture = Date.now() + 10 * 365 * 24 * 60 * 60 * 1000;
    localStorage.setItem(SPOTIFY_NEXT_ALLOWED_AT_KEY, String(farFuture));
    vi.resetModules();
    const fresh = await import("./apiClient");
    const restored = fresh.__getSpotifyRateLimitStateForTests().nextAllowedAt;
    expect(restored).toBeLessThanOrEqual(Date.now() + 60_000);
    expect(restored).toBeGreaterThan(Date.now());
  });
});

describe("global refresh pattern (concurrent callers)", () => {
  it("spaces 4 concurrent callers at MIN_SPACING_MS each", async () => {
    const sendTimestamps: number[] = [];
    const send = vi.fn(async () => {
      sendTimestamps.push(Date.now());
      return ok();
    });

    const startedAt = Date.now();
    const promises = [
      submitTokenRequest(send, "/a"),
      submitTokenRequest(send, "/b"),
      submitTokenRequest(send, "/c"),
      submitTokenRequest(send, "/d"),
    ];

    await vi.advanceTimersByTimeAsync(0);
    expect(sendTimestamps).toEqual([startedAt]);

    await vi.advanceTimersByTimeAsync(MIN_SPACING_MS);
    expect(sendTimestamps).toEqual([startedAt, startedAt + MIN_SPACING_MS]);

    await vi.advanceTimersByTimeAsync(MIN_SPACING_MS);
    expect(sendTimestamps).toEqual([
      startedAt,
      startedAt + MIN_SPACING_MS,
      startedAt + 2 * MIN_SPACING_MS,
    ]);

    await vi.advanceTimersByTimeAsync(MIN_SPACING_MS);
    expect(sendTimestamps).toEqual([
      startedAt,
      startedAt + MIN_SPACING_MS,
      startedAt + 2 * MIN_SPACING_MS,
      startedAt + 3 * MIN_SPACING_MS,
    ]);

    await Promise.all(promises);
  });

  it("pendingCount reflects queued + in-flight callers, decrements as they finish", async () => {
    const send = vi.fn(async () => ok());

    const promises = [
      settle(submitTokenRequest(send, "/a")),
      settle(submitTokenRequest(send, "/b")),
      settle(submitTokenRequest(send, "/c")),
    ];

    // Right after 3 synchronous enqueues, depth includes all 3
    // (queued + about-to-run). The exact split between
    // pending-vs-in-flight doesn't matter to a UI observer.
    expect(getPendingSpotifyRequestCount()).toBe(3);

    // After enough time for one task to start and finish.
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(MIN_SPACING_MS);
    expect(getPendingSpotifyRequestCount()).toBeLessThanOrEqual(2);

    await vi.advanceTimersByTimeAsync(MIN_SPACING_MS * 3);
    expect(getPendingSpotifyRequestCount()).toBe(0);

    await Promise.all(promises);
  });

  it("a 429 mid-batch opens the circuit and the remaining callers fail fast (no compounding)", async () => {
    let callIndex = 0;
    const send = vi.fn(async () => {
      callIndex++;
      if (callIndex === 1) return tooMany("60");
      return ok();
    });

    const p1 = settle(submitTokenRequest(send, "/a"));
    const p2 = settle(submitTokenRequest(send, "/b"));

    await vi.advanceTimersByTimeAsync(0);
    await p1;
    expect(send).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(MIN_SPACING_MS);
    await p2;
    // Critical: the second caller MUST NOT have fired. The whole
    // point of the breaker is to not extend a ban by hitting Spotify
    // again inside the penalty window.
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("subsequent unrelated calls during an open circuit also fail fast (no extra send)", async () => {
    const send = vi.fn(async () => tooMany("30"));
    const rej = captureRejection(submitTokenRequest(send, "/a"));
    await vi.advanceTimersByTimeAsync(0);
    expect(await rej).toBeInstanceOf(SpotifyRateLimitError);
    expect(send).toHaveBeenCalledTimes(1);

    const sendLater = vi.fn(async () => ok());
    const rej2 = captureRejection(submitTokenRequest(sendLater, "/b"));
    expect(await rej2).toBeInstanceOf(SpotifyRateLimitError);
    expect(sendLater).not.toHaveBeenCalled();
  });

  it("a 429 with NO Retry-After defaults to 5min (NOT 30s — protects against CORS-hidden multi-hour bans)", async () => {
    const send = vi.fn(async () => tooMany(null));
    const rej = captureRejection(submitTokenRequest(send, "/search"));
    await vi.advanceTimersByTimeAsync(0);
    expect(await rej).toBeInstanceOf(SpotifyRateLimitError);

    // The breaker — not the queue spacing — owns the cool-off. Open
    // for at least ~5 minutes. (Subsequent callers fail fast via the
    // breaker; the queue's nextRunAt only advances by the normal
    // 350ms interval, which doesn't matter because no caller will
    // actually send anything until the breaker closes.)
    expect(spotifyCircuitOpenMs()).toBeGreaterThanOrEqual(5 * 60_000 - 1000);
  });
});

describe("manual item refresh pattern (single call)", () => {
  it("a 429 on a single call opens the circuit for at least Retry-After", async () => {
    const send = vi.fn(async () => tooMany("45"));
    const startedAt = Date.now();
    const rej = captureRejection(submitTokenRequest(send, "/search"));
    await vi.advanceTimersByTimeAsync(0);
    expect(await rej).toBeInstanceOf(SpotifyRateLimitError);

    expect(spotifyCircuitOpenMs()).toBeGreaterThanOrEqual(45_000 - 1000);
    // Don't exceed the honored window by much.
    expect(Date.now() + spotifyCircuitOpenMs()).toBeLessThanOrEqual(
      startedAt + 60_000,
    );
  });

  it("a 429 does NOT retry inside the call (regression: old code fired up to 4 requests per call)", async () => {
    const send = vi.fn(async () => tooMany("60"));
    const rej = captureRejection(submitTokenRequest(send, "/search"));
    await vi.advanceTimersByTimeAsync(0);
    expect(await rej).toBeInstanceOf(SpotifyRateLimitError);

    // ONE 429 response = exactly ONE outbound request. The old loop
    // could fire up to MAX_RETRY_ATTEMPTS=3 inside the penalty window,
    // extending the ban under Spotify's sustained-abuse policy.
    expect(send).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("a single successful call leaves the circuit closed and advances nextAllowedAt", async () => {
    const send = vi.fn(async () => ok());
    const startedAt = Date.now();
    const p = submitTokenRequest(send, "/me");
    await vi.advanceTimersByTimeAsync(0);
    await p;

    expect(spotifyCircuitOpenMs()).toBe(0);
    expect(__getSpotifyRateLimitStateForTests().nextAllowedAt).toBe(
      startedAt + MIN_SPACING_MS,
    );
  });
});

describe("circuit breaker half-open / probe semantics", () => {
  it("half-open: first caller after expiry becomes the probe, others fail fast", async () => {
    // Trip the breaker with a short window.
    {
      const send1 = vi.fn(async () => tooMany("5"));
      const rej = captureRejection(submitTokenRequest(send1, "/a"));
      await vi.advanceTimersByTimeAsync(0);
      expect(await rej).toBeInstanceOf(SpotifyRateLimitError);
    }

    // Window elapses (must exceed the 5s breaker-min floor too).
    await vi.advanceTimersByTimeAsync(6_000);

    const sendProbe = vi.fn(async () => ok());
    const sendOther = vi.fn(async () => ok());

    const probePromise = submitTokenRequest(sendProbe, "/probe");
    const otherRej = captureRejection(
      submitTokenRequest(sendOther, "/other"),
    );

    expect(await otherRej).toBeInstanceOf(SpotifyRateLimitError);
    expect(sendOther).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(0);
    await probePromise;

    expect(sendProbe).toHaveBeenCalledTimes(1);
    expect(spotifyCircuitOpenMs()).toBe(0);
  });

  it("probe 429 reopens the circuit for the new Retry-After", async () => {
    {
      const send = vi.fn(async () => tooMany("5"));
      const rej = captureRejection(submitTokenRequest(send, "/a"));
      await vi.advanceTimersByTimeAsync(0);
      expect(await rej).toBeInstanceOf(SpotifyRateLimitError);
    }

    await vi.advanceTimersByTimeAsync(6_000);

    const sendProbe = vi.fn(async () => tooMany("120"));
    const probeRej = captureRejection(submitTokenRequest(sendProbe, "/probe"));
    await vi.advanceTimersByTimeAsync(0);
    expect(await probeRej).toBeInstanceOf(SpotifyRateLimitError);

    expect(spotifyCircuitOpenMs()).toBeGreaterThanOrEqual(120_000 - 1000);
    // And subsequent callers fail fast against the new window.
    const sendAfter = vi.fn(async () => ok());
    const afterRej = captureRejection(
      submitTokenRequest(sendAfter, "/after"),
    );
    expect(await afterRej).toBeInstanceOf(SpotifyRateLimitError);
    expect(sendAfter).not.toHaveBeenCalled();
  });

  it("a non-429 success from the probe closes the circuit, releasing waiting callers", async () => {
    {
      const send = vi.fn(async () => tooMany("3"));
      const rej = captureRejection(submitTokenRequest(send, "/a"));
      await vi.advanceTimersByTimeAsync(0);
      expect(await rej).toBeInstanceOf(SpotifyRateLimitError);
    }

    // Breaker has a 5s minimum open window — advance past that, not
    // just past the Retry-After value.
    await vi.advanceTimersByTimeAsync(6_000);

    const sendProbe = vi.fn(async () => ok());
    const probePromise = submitTokenRequest(sendProbe, "/probe");
    await vi.advanceTimersByTimeAsync(0);
    await probePromise;

    expect(spotifyCircuitOpenMs()).toBe(0);

    // A fresh caller after the close goes through normally.
    const sendNext = vi.fn(async () => ok());
    const nextP = submitTokenRequest(sendNext, "/next");
    await vi.advanceTimersByTimeAsync(MIN_SPACING_MS);
    await nextP;
    expect(sendNext).toHaveBeenCalledTimes(1);
  });

  it("resetSpotifyCircuit closes the breaker but leaves the spacing window alone", async () => {
    {
      const send = vi.fn(async () => tooMany("60"));
      const rej = captureRejection(submitTokenRequest(send, "/a"));
      await vi.advanceTimersByTimeAsync(0);
      expect(await rej).toBeInstanceOf(SpotifyRateLimitError);
    }

    const stateBeforeReset = __getSpotifyRateLimitStateForTests();
    expect(spotifyCircuitOpenMs()).toBeGreaterThan(0);
    expect(stateBeforeReset.nextAllowedAt).toBeGreaterThan(Date.now());

    resetSpotifyCircuit();

    expect(spotifyCircuitOpenMs()).toBe(0);
    // Spacing window untouched.
    expect(__getSpotifyRateLimitStateForTests().nextAllowedAt).toBe(
      stateBeforeReset.nextAllowedAt,
    );
  });

  it("circuit-open period persists to localStorage so a reload honors it", async () => {
    const send = vi.fn(async () => tooMany("90"));
    const rej = captureRejection(submitTokenRequest(send, "/a"));
    await vi.advanceTimersByTimeAsync(0);
    expect(await rej).toBeInstanceOf(SpotifyRateLimitError);

    const persisted = localStorage.getItem(SPOTIFY_CIRCUIT_OPEN_UNTIL_KEY);
    expect(persisted).toBeTruthy();
    const parsed = Number(persisted);
    expect(parsed).toBeGreaterThanOrEqual(Date.now() + 90_000 - 1000);
  });
});

describe("invariants under concurrent traffic", () => {
  it("only one of N concurrent callers sends after a 429 — the rest fail fast", async () => {
    let firstResponse: Response | null = tooMany("30");
    const send = vi.fn(async () => {
      const r = firstResponse ?? ok();
      firstResponse = null;
      return r;
    });

    const N = 8;
    const promises = Array.from({ length: N }, (_, i) =>
      settle(submitTokenRequest(send, `/x${i}`)),
    );

    await vi.advanceTimersByTimeAsync(N * MIN_SPACING_MS);

    await Promise.all(promises);
    // Exactly one outbound request. Seven other callers must have
    // been short-circuited by the open breaker.
    expect(send).toHaveBeenCalledTimes(1);
  });
});
