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
//   - rate cap: at most 180 requests go out per 60s window (334ms gap)
//   - "global refresh" pattern: N concurrent callers space at 334ms
//   - "global refresh" pattern: 429 mid-batch opens the circuit and
//     every subsequent caller fails fast (no compounding)
//   - 10-minute hard floor: a single 429 locks out ALL outbound
//     traffic — API, token refresh, and player calls — for at least
//     10 minutes, and the lockout survives a browser close/reopen,
//     manual refresh, and hard refresh (persisted to localStorage)
//   - "manual item refresh" pattern: one call, respects open circuit
//   - circuit-breaker half-open: exactly one probe is admitted
//   - probe success closes the circuit
//   - probe 429 reopens for the new window
//   - Retry-After missing → 5-minute default, floored up to 10 minutes
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

// submitSpotifyRequest pulls an access token through authFlow on every
// call. The auth machinery (PKCE, token refresh, sessionStorage) isn't
// what these tests are exercising — they're exercising the wrapper's
// status-code mapping and rate-limit policy — so stub the token getter
// with a fixed string and bypass the rest.
vi.mock("./authFlow", () => ({
  getValidAccessToken: vi.fn(async () => "test-access-token"),
  runWithRateLimitPolicy: vi.fn(),
}));

import {
  __getSpotifyRateLimitStateForTests,
  __resetSpotifyRateLimitStateForTests,
  cancelSpotifyRequestsByTag,
  getPendingSpotifyRequestCount,
  RequestCancelledError,
  resetSpotifyCircuit,
  spotifyCircuitOpenMs,
  SpotifyAuthExpiredError,
  SpotifyForbiddenError,
  SpotifyHttpError,
  SpotifyNetworkError,
  SpotifyRateLimitError,
  SpotifyServerError,
  submitSpotifyRequest,
  submitTokenRequest,
} from "./apiClient";
import {
  SPOTIFY_CIRCUIT_OPEN_UNTIL_KEY,
  SPOTIFY_NEXT_ALLOWED_AT_KEY,
} from "../constants";

// Mirror of the production constants. The pacer admits at most 180
// requests per minute, realized as a 334ms gap between sends
// (ceil(60000/180)). When a 429 carries NO usable Retry-After (the
// common CORS-hidden case) the breaker falls back to a 10-minute
// default lockout; when a real Retry-After IS present it is honored
// instead.
const MAX_REQUESTS_PER_MINUTE = 180;
const MIN_SPACING_MS = Math.ceil(60_000 / MAX_REQUESTS_PER_MINUTE); // 334
const DEFAULT_LOCKOUT_MS = 10 * 60_000;

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

describe("rate cap (180 requests per minute)", () => {
  it("admits at most 180 sends in any 60-second window", async () => {
    let sendCount = 0;
    const send = vi.fn(async () => {
      sendCount++;
      return ok();
    });

    // Queue far more callers than a single minute can admit.
    const promises = Array.from({ length: 250 }, (_, i) =>
      settle(submitTokenRequest(send, `/q${i}`)),
    );

    // Advance to the last millisecond of the first minute. With a 334ms
    // gap the sends land at 0, 334, … , 59786 (k = 0..179) — exactly
    // 180. The 181st is paced out to 334×180 = 60120ms, past the minute.
    await vi.advanceTimersByTimeAsync(60_000 - 1);
    expect(sendCount).toBe(180);

    // Cross into the next minute — the 181st now fires.
    await vi.advanceTimersByTimeAsync(200);
    expect(sendCount).toBe(181);

    await vi.advanceTimersByTimeAsync(250 * MIN_SPACING_MS);
    await Promise.all(promises);
  });

  it("spaces consecutive sends by 334ms = ceil(60000/180)", async () => {
    // The cap is realized as a fixed inter-send gap, not a burst-
    // allowing token bucket. 334 (ceil, not floor) guarantees the
    // realized rate never exceeds 180/min.
    expect(MIN_SPACING_MS).toBe(334);

    const timestamps: number[] = [];
    const send = vi.fn(async () => {
      timestamps.push(Date.now());
      return ok();
    });
    const startedAt = Date.now();
    const promises = [
      settle(submitTokenRequest(send, "/a")),
      settle(submitTokenRequest(send, "/b")),
      settle(submitTokenRequest(send, "/c")),
    ];

    await vi.advanceTimersByTimeAsync(2 * MIN_SPACING_MS);
    expect(timestamps).toEqual([
      startedAt,
      startedAt + MIN_SPACING_MS,
      startedAt + 2 * MIN_SPACING_MS,
    ]);
    await Promise.all(promises);
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

  it("a 429 with NO Retry-After (CORS-hidden) locks out for the 10-min default", async () => {
    const send = vi.fn(async () => tooMany(null));
    const rej = captureRejection(submitTokenRequest(send, "/search"));
    await vi.advanceTimersByTimeAsync(0);
    expect(await rej).toBeInstanceOf(SpotifyRateLimitError);

    // No readable Retry-After → fall back to the 10-minute default. The
    // breaker — not the queue spacing — owns the cool-off. (Subsequent
    // callers fail fast via the breaker; the queue's nextRunAt only
    // advances by the normal 334ms interval, which doesn't matter
    // because no caller sends anything until the breaker closes.)
    expect(spotifyCircuitOpenMs()).toBeGreaterThanOrEqual(
      DEFAULT_LOCKOUT_MS - 1000,
    );
    expect(spotifyCircuitOpenMs()).toBeLessThan(DEFAULT_LOCKOUT_MS + 60_000);
  });
});

describe("manual item refresh pattern (single call)", () => {
  it("a 429 with a real Retry-After honors that value (not the 10-min default)", async () => {
    const send = vi.fn(async () => tooMany("45"));
    const startedAt = Date.now();
    const rej = captureRejection(submitTokenRequest(send, "/search"));
    await vi.advanceTimersByTimeAsync(0);
    expect(await rej).toBeInstanceOf(SpotifyRateLimitError);

    // Spotify said 45s — honor it. The 10-min default applies ONLY when
    // no Retry-After is readable, so a real value must not be inflated.
    expect(spotifyCircuitOpenMs()).toBeGreaterThanOrEqual(45_000 - 1000);
    // Don't exceed the honored window by much (well under 10 min).
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

    // Window elapses — the 5s Retry-After is honored, so a hair past it
    // (and past the breaker's 5s minimum) is enough.
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

    // The 3s Retry-After is honored but bumped to the breaker's 5s
    // minimum — advance just past that.
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

  it("consecutive probe 429s double the open window each time (CORS-hidden multi-hour ban)", async () => {
    // Trip #1: CORS-hidden Retry-After → 10-min default.
    {
      const send = vi.fn(async () => tooMany(null));
      const rej = captureRejection(submitTokenRequest(send, "/a"));
      await vi.advanceTimersByTimeAsync(0);
      expect(await rej).toBeInstanceOf(SpotifyRateLimitError);
      expect(spotifyCircuitOpenMs()).toBeGreaterThanOrEqual(
        DEFAULT_LOCKOUT_MS - 1000,
      );
      expect(spotifyCircuitOpenMs()).toBeLessThan(DEFAULT_LOCKOUT_MS + 60_000);
    }

    // Wait out the 10-min window, fire a probe — still 429.
    await vi.advanceTimersByTimeAsync(DEFAULT_LOCKOUT_MS + 1000);
    {
      const sendProbe = vi.fn(async () => tooMany(null));
      const rej = captureRejection(submitTokenRequest(sendProbe, "/probe"));
      await vi.advanceTimersByTimeAsync(0);
      expect(await rej).toBeInstanceOf(SpotifyRateLimitError);
      // Trip #2 escalates to ~20 min (10-min default × 2).
      expect(spotifyCircuitOpenMs()).toBeGreaterThanOrEqual(20 * 60_000 - 1000);
      expect(spotifyCircuitOpenMs()).toBeLessThan(21 * 60_000);
    }

    await vi.advanceTimersByTimeAsync(20 * 60_000 + 1000);
    {
      const sendProbe = vi.fn(async () => tooMany(null));
      const rej = captureRejection(submitTokenRequest(sendProbe, "/probe"));
      await vi.advanceTimersByTimeAsync(0);
      expect(await rej).toBeInstanceOf(SpotifyRateLimitError);
      // Trip #3 escalates to ~40 min (10-min default × 4).
      expect(spotifyCircuitOpenMs()).toBeGreaterThanOrEqual(40 * 60_000 - 1000);
    }
  });

  it("a successful probe resets the escalation counter (next 429 starts fresh)", async () => {
    // Trip #1 (null → 10-min default).
    {
      const send = vi.fn(async () => tooMany(null));
      const rej = captureRejection(submitTokenRequest(send, "/a"));
      await vi.advanceTimersByTimeAsync(0);
      expect(await rej).toBeInstanceOf(SpotifyRateLimitError);
    }
    // Wait out the 10-min window, probe — still 429 → trip #2 (~20 min).
    await vi.advanceTimersByTimeAsync(DEFAULT_LOCKOUT_MS + 1000);
    {
      const sendProbe = vi.fn(async () => tooMany(null));
      const rej = captureRejection(submitTokenRequest(sendProbe, "/probe"));
      await vi.advanceTimersByTimeAsync(0);
      expect(await rej).toBeInstanceOf(SpotifyRateLimitError);
    }

    // Successful probe closes the circuit and resets counter — wait out
    // the escalated 20-min window first.
    await vi.advanceTimersByTimeAsync(2 * DEFAULT_LOCKOUT_MS + 1000);
    {
      const sendProbe = vi.fn(async () => ok());
      const p = submitTokenRequest(sendProbe, "/probe");
      await vi.advanceTimersByTimeAsync(0);
      await p;
      expect(spotifyCircuitOpenMs()).toBe(0);
    }

    // A fresh 429 now is trip #1 again — back at the unescalated 10-min
    // default, not the next exponential step.
    await vi.advanceTimersByTimeAsync(MIN_SPACING_MS);
    {
      const send = vi.fn(async () => tooMany(null));
      const rej = captureRejection(submitTokenRequest(send, "/b"));
      await vi.advanceTimersByTimeAsync(0);
      expect(await rej).toBeInstanceOf(SpotifyRateLimitError);
      expect(spotifyCircuitOpenMs()).toBeGreaterThanOrEqual(
        DEFAULT_LOCKOUT_MS - 1000,
      );
      expect(spotifyCircuitOpenMs()).toBeLessThan(DEFAULT_LOCKOUT_MS + 60_000);
    }
  });

  it("escalation count persists across reload (so a fresh tab doesn't restart at trip #1)", async () => {
    // Trip twice in the original module.
    {
      const send = vi.fn(async () => tooMany(null));
      const rej = captureRejection(submitTokenRequest(send, "/a"));
      await vi.advanceTimersByTimeAsync(0);
      expect(await rej).toBeInstanceOf(SpotifyRateLimitError);
    }
    await vi.advanceTimersByTimeAsync(DEFAULT_LOCKOUT_MS + 1000);
    {
      const sendProbe = vi.fn(async () => tooMany(null));
      const rej = captureRejection(submitTokenRequest(sendProbe, "/probe"));
      await vi.advanceTimersByTimeAsync(0);
      expect(await rej).toBeInstanceOf(SpotifyRateLimitError);
    }

    // Reload the module after the (escalated, ~20-min) trip #2 window
    // elapses. The counter (= 2) carries over: the next trip should
    // escalate as if it were trip #3 (×4), not trip #1 (×1).
    await vi.advanceTimersByTimeAsync(2 * DEFAULT_LOCKOUT_MS + 1000);
    vi.resetModules();
    const fresh = await import("./apiClient");

    const send = vi.fn(async () => tooMany(null));
    const rej = fresh
      .submitTokenRequest(send, "/c")
      .catch((e) => e);
    await vi.advanceTimersByTimeAsync(0);
    await rej;
    // Trip #3 → 40 min (10-min default × 4).
    expect(fresh.spotifyCircuitOpenMs()).toBeGreaterThanOrEqual(
      40 * 60_000 - 1000,
    );
  });
});

// The user requirement: after a single 429, NOTHING may reach Spotify
// for the full lockout — not even player API calls — and the lockout
// must survive a browser close/reopen, a manual refresh, and a hard
// refresh. We model every kind of refresh as a `vi.resetModules()` +
// re-import: the in-memory breaker state is thrown away and rebuilt
// solely from localStorage, exactly as a fresh page load would.
describe("10-minute default lockout survives every kind of refresh", () => {
  it("a CORS-hidden 429 blocks even player API calls after a reload", async () => {
    // Take a 429 with no readable Retry-After → 10-min default lockout.
    {
      const send = vi.fn(async () => tooMany(null));
      const rej = captureRejection(
        submitTokenRequest(send, "/me/player/play"),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(await rej).toBeInstanceOf(SpotifyRateLimitError);
    }

    // Simulate a browser close/reopen (or manual / hard refresh): drop
    // the module and rebuild from localStorage only.
    vi.resetModules();
    const fresh = await import("./apiClient");

    // The lockout is restored — still ~10 minutes remaining.
    expect(fresh.spotifyCircuitOpenMs()).toBeGreaterThanOrEqual(
      DEFAULT_LOCKOUT_MS - 1000,
    );

    // A PLAYER API call (the path the user can manually trigger) is
    // blocked too: it fails fast against the open breaker and never
    // reaches fetch. Save/restore the real fetch directly rather than
    // unstubbing globals (which would also wipe the localStorage stub).
    const realFetch = globalThis.fetch;
    const fetchSpy = vi.fn(async () => ok());
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    try {
      const playRej = captureRejection(
        fresh.submitSpotifyRequest(
          { path: "/me/player/play", method: "PUT", body: { uris: ["x"] } },
          "client-id",
        ),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(await playRej).toBeInstanceOf(fresh.SpotifyRateLimitError);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("repeated refreshes within the window cannot shorten the lockout", async () => {
    {
      const send = vi.fn(async () => tooMany(null));
      const rej = captureRejection(submitTokenRequest(send, "/a"));
      await vi.advanceTimersByTimeAsync(0);
      expect(await rej).toBeInstanceOf(SpotifyRateLimitError);
    }

    // Nine minutes in — still inside the 10-min window. A refresh here
    // must not reset the clock or admit a probe early.
    await vi.advanceTimersByTimeAsync(9 * 60_000);
    vi.resetModules();
    const fresh = await import("./apiClient");
    expect(fresh.spotifyCircuitOpenMs()).toBeGreaterThan(0);

    const send = vi.fn(async () => ok());
    const rej = captureRejection(fresh.submitTokenRequest(send, "/me"));
    await vi.advanceTimersByTimeAsync(0);
    expect(await rej).toBeInstanceOf(fresh.SpotifyRateLimitError);
    expect(send).not.toHaveBeenCalled();
  });
});

// Player commands are user-triggered and latency-sensitive — they must
// cut ahead of the background search/enrichment backlog. They still
// respect the spacing gap and the circuit breaker; preemption only
// reorders the WAITING queue.
describe("player commands preempt search activity", () => {
  it("a high-priority player call jumps ahead of queued search requests", async () => {
    const order: string[] = [];
    const realFetch = globalThis.fetch;
    const fetchSpy = vi.fn(async (url: string) => {
      order.push(new URL(url).pathname);
      return ok();
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    try {
      // Three background search requests enqueue first. The first one
      // takes the immediate slot and goes in flight; the rest wait.
      const searches = Array.from({ length: 3 }, (_, i) =>
        settle(submitSpotifyRequest({ path: `/search?q=${i}` }, "cid")),
      );
      // The player command is enqueued LAST but at high priority.
      const play = settle(
        submitSpotifyRequest(
          { path: "/me/player/play", method: "PUT", body: { uris: ["x"] } },
          "cid",
          { priority: "high" },
        ),
      );

      await vi.advanceTimersByTimeAsync(10 * MIN_SPACING_MS);
      await Promise.all([...searches, play]);

      // First out is the already-dispatched search; the player command
      // ran 2nd — ahead of the two searches still queued behind it.
      expect(order[0]).toContain("/search");
      expect(order[1]).toContain("/me/player/play");
      expect(order.slice(2).every((p) => p.includes("/search"))).toBe(true);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("a player call still fails fast during an open circuit (preemption doesn't bypass the breaker)", async () => {
    // Trip the breaker.
    {
      const send = vi.fn(async () => tooMany(null));
      const rej = captureRejection(submitTokenRequest(send, "/a"));
      await vi.advanceTimersByTimeAsync(0);
      expect(await rej).toBeInstanceOf(SpotifyRateLimitError);
    }

    const realFetch = globalThis.fetch;
    const fetchSpy = vi.fn(async () => ok());
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    try {
      const playRej = captureRejection(
        submitSpotifyRequest(
          { path: "/me/player/play", method: "PUT", body: { uris: ["x"] } },
          "cid",
          { priority: "high" },
        ),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(await playRej).toBeInstanceOf(SpotifyRateLimitError);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = realFetch;
    }
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

// submitSpotifyRequest funnels through `sendOnce` (which calls
// `fetch`) and then `mapStatusToResult` (which inspects status). These
// tests stub global fetch with a fixed Response and verify the typed
// error contract.
describe("status-code error mapping", () => {
  // Each test sets its own response shape via this handler.
  let nextResponse: () => Response | Promise<Response>;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    nextResponse = () => ok();
    fetchSpy = vi.fn(async () => nextResponse());
    vi.stubGlobal("fetch", fetchSpy);
  });

  it("401 → SpotifyAuthExpiredError (token treated as stale, not retried)", async () => {
    nextResponse = () => new Response("", { status: 401 });
    const rej = captureRejection(
      submitSpotifyRequest({ path: "/me" }, "client-id"),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(await rej).toBeInstanceOf(SpotifyAuthExpiredError);
    // Exactly one outbound fetch — auth errors are not retried inside
    // the wrapper; the caller decides whether to prompt re-auth.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("403 → SpotifyForbiddenError carrying the requested path", async () => {
    nextResponse = () =>
      new Response("Insufficient client scope", { status: 403 });
    const rej = captureRejection(
      submitSpotifyRequest({ path: "/me/player/play" }, "client-id"),
    );
    await vi.advanceTimersByTimeAsync(0);
    const error = await rej;
    expect(error).toBeInstanceOf(SpotifyForbiddenError);
    expect((error as SpotifyForbiddenError).path).toBe("/me/player/play");
  });

  it("500 → SpotifyServerError carrying status + path", async () => {
    nextResponse = () => new Response("upstream blew up", { status: 500 });
    const rej = captureRejection(
      submitSpotifyRequest({ path: "/search" }, "client-id"),
    );
    await vi.advanceTimersByTimeAsync(0);
    const error = await rej;
    expect(error).toBeInstanceOf(SpotifyServerError);
    expect((error as SpotifyServerError).status).toBe(500);
    expect((error as SpotifyServerError).path).toBe("/search");
  });

  it("502 and 503 are also surfaced as SpotifyServerError (status preserved)", async () => {
    for (const status of [502, 503] as const) {
      __resetSpotifyRateLimitStateForTests();
      nextResponse = () => new Response("", { status });
      const rej = captureRejection(
        submitSpotifyRequest({ path: "/me" }, "client-id"),
      );
      await vi.advanceTimersByTimeAsync(0);
      const error = await rej;
      expect(error).toBeInstanceOf(SpotifyServerError);
      expect((error as SpotifyServerError).status).toBe(status);
    }
  });

  it("5xx is NOT retried (single-shot policy applies to all statuses, not just 429)", async () => {
    nextResponse = () => new Response("", { status: 500 });
    const rej = captureRejection(
      submitSpotifyRequest({ path: "/me" }, "client-id"),
    );
    await vi.advanceTimersByTimeAsync(0);
    await rej;
    // Advance well past any plausible retry window — fetch must still
    // have been called exactly once.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("network failure (fetch throws) → SpotifyNetworkError wrapping the cause", async () => {
    const cause = new TypeError("Failed to fetch");
    fetchSpy.mockImplementationOnce(async () => {
      throw cause;
    });
    const rej = captureRejection(
      submitSpotifyRequest({ path: "/me" }, "client-id"),
    );
    await vi.advanceTimersByTimeAsync(0);
    const error = await rej;
    expect(error).toBeInstanceOf(SpotifyNetworkError);
    expect((error as Error).message).toContain("Failed to fetch");
  });

  it("a 5xx error does NOT trip the circuit breaker (only 429 does)", async () => {
    nextResponse = () => new Response("", { status: 503 });
    const rej = captureRejection(
      submitSpotifyRequest({ path: "/me" }, "client-id"),
    );
    await vi.advanceTimersByTimeAsync(0);
    await rej;
    // A transient 5xx must not strand the breaker open — that would
    // mask the upstream blip as an app-wide rate-limit pause.
    expect(spotifyCircuitOpenMs()).toBe(0);
  });

  it("204 No Content resolves with undefined (no JSON parse attempted)", async () => {
    nextResponse = () => new Response(null, { status: 204 });
    const p = submitSpotifyRequest<undefined>(
      { path: "/me/player/play", method: "PUT", body: { uris: ["x"] } },
      "client-id",
    );
    await vi.advanceTimersByTimeAsync(0);
    await expect(p).resolves.toBeUndefined();
  });

  it("200 with an empty body resolves with undefined (Content-Length: 0 path)", async () => {
    nextResponse = () =>
      new Response("", {
        status: 200,
        headers: { "Content-Length": "0" },
      });
    const p = submitSpotifyRequest<undefined>(
      { path: "/me/following", method: "PUT" },
      "client-id",
    );
    await vi.advanceTimersByTimeAsync(0);
    await expect(p).resolves.toBeUndefined();
  });

  it("200 with JSON body resolves with the parsed value", async () => {
    nextResponse = () =>
      new Response(JSON.stringify({ id: "u-1", display_name: "alice" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    const result = await submitSpotifyRequest<{
      id: string;
      display_name: string;
    }>({ path: "/me" }, "client-id");
    expect(result).toEqual({ id: "u-1", display_name: "alice" });
  });

  it("other non-ok status (e.g. 400) → SpotifyHttpError carrying status + path", async () => {
    nextResponse = () =>
      new Response("Bad Request: missing field", { status: 400 });
    const rej = captureRejection(
      submitSpotifyRequest({ path: "/me/playlists", method: "POST" }, "cid"),
    );
    await vi.advanceTimersByTimeAsync(0);
    const error = await rej;
    expect(error).toBeInstanceOf(SpotifyHttpError);
    expect((error as SpotifyHttpError).status).toBe(400);
    expect((error as SpotifyHttpError).path).toBe("/me/playlists");
    // And the typed-error hierarchy is disjoint — a 400 is not a
    // server error, not a forbidden, not an auth-expired.
    expect(error).not.toBeInstanceOf(SpotifyAuthExpiredError);
    expect(error).not.toBeInstanceOf(SpotifyForbiddenError);
    expect(error).not.toBeInstanceOf(SpotifyServerError);
  });
});

// Regression: a circuit-breaker probe slot must be released even when
// the queued task is cancelled before its body runs. Pre-fix, the
// `releaseProbe()` call lived inside the task body's `finally`, which
// never fires for either `cancelByTag` or a `guard`-fail rejection.
// The bug stranded `probeInFlight = true` for the rest of the
// session, so every subsequent caller failed fast against an empty
// open window forever. The fix lifts releaseProbe to an outer
// try/finally that wraps the entire queue.enqueue — both the
// normal-body path and the reject-without-body path release the slot.
//
// The two reject-without-body paths share the same code path through
// the queue (both end up rejecting `queue.enqueue`'s outer promise
// before the task body runs). The `guard` path is the one we exercise
// here because it's straightforward to trigger; `cancelByTag` would
// require a multi-task pending-queue scenario that's awkward to set
// up under fake timers (drain dispatches sync when `nextRunAt` is in
// the past). The fix is symmetrical — both paths route through the
// same outer try/finally.
describe("probe-slot release on cancellation", () => {
  it("guard-fail on the lone half-open probe does NOT strand probeInFlight", async () => {
    // Trip the breaker.
    {
      const send = vi.fn(async () => tooMany("5"));
      const rej = captureRejection(submitTokenRequest(send, "/trip"));
      await vi.advanceTimersByTimeAsync(0);
      expect(await rej).toBeInstanceOf(SpotifyRateLimitError);
    }
    await vi.advanceTimersByTimeAsync(6_000);

    // Probe whose guard will return false at task-pop time. tryAcquire
    // synchronously returns "probe" and sets probeInFlight = true.
    const sendProbe = vi.fn(async () => ok());
    const probeRej = captureRejection(
      submitSpotifyRequest(
        { path: "/probe" },
        "cid",
        { guard: () => false, tag: "track-being-deleted" },
      ),
    );

    // Let the queue dispatch — guard returns false at task-pop and
    // rejects with RequestCancelledError BEFORE the body runs.
    await vi.advanceTimersByTimeAsync(0);
    expect(await probeRej).toBeInstanceOf(RequestCancelledError);
    expect(sendProbe).not.toHaveBeenCalled();

    // The defining check: probeInFlight must have been released even
    // though the body never ran. Next caller must be admitted as the
    // new probe and succeed.
    const sendNext = vi.fn(async () => ok());
    const nextPromise = submitTokenRequest(sendNext, "/next");
    await vi.advanceTimersByTimeAsync(MIN_SPACING_MS);
    await nextPromise;
    expect(sendNext).toHaveBeenCalledTimes(1);
    expect(spotifyCircuitOpenMs()).toBe(0);
  });

  it("cancelSpotifyRequestsByTag is a no-op when no pending tasks match (sanity)", () => {
    // Sanity that the cancel API exists and is callable from the
    // wrapper — the deeper cancelByTag-finds-probe scenario lives
    // outside this test (see comment above).
    expect(cancelSpotifyRequestsByTag("nonexistent")).toBe(0);
  });
});
