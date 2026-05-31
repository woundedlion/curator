// Isolated unit tests for the CircuitBreaker state machine. The breaker is
// also exercised end-to-end through apiClient in rateLimit.test.ts, but
// several branches — the localStorage corruption caps, the escalation-decay
// boundary in the constructor, and the minOpenMs floor in isolation — are
// awkward to drive through the HTTP wrapper because they hinge on planting
// a specific persisted (openUntil, failureCount) pair before construction.
// These tests plant that state directly.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SPOTIFY_CIRCUIT_FAILURE_COUNT_KEY,
  SPOTIFY_CIRCUIT_OPEN_UNTIL_KEY,
} from "../constants";

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

import { CircuitBreaker } from "./circuitBreaker";

const NOW = 1_700_000_000_000;
const MIN_OPEN_MS = 5_000;
const MAX_OPEN_MS = 12 * 60 * 60 * 1000; // 12h

function newBreaker() {
  return new CircuitBreaker({ minOpenMs: MIN_OPEN_MS, maxOpenMs: MAX_OPEN_MS });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("CircuitBreaker — basic state machine", () => {
  it("passes when closed", () => {
    expect(newBreaker().tryAcquire()).toBe("pass");
  });

  it("fails fast while the window is open after a trip", () => {
    const b = newBreaker();
    b.trip(60_000);
    expect(b.tryAcquire()).toBe("fail-fast");
    expect(b.remainingMs()).toBe(60_000);
  });

  it("admits exactly one probe when the window elapses, then fails fast until it settles", () => {
    const b = newBreaker();
    b.trip(60_000);
    vi.advanceTimersByTime(60_000);
    expect(b.tryAcquire()).toBe("probe");
    // A second caller during the in-flight probe is rejected.
    expect(b.tryAcquire()).toBe("fail-fast");
    // Probe fails → releaseProbe lets the next elapsed caller probe again.
    b.releaseProbe();
    expect(b.tryAcquire()).toBe("probe");
  });

  it("close() after a successful probe re-opens the gate and resets escalation", () => {
    const b = newBreaker();
    b.trip(60_000);
    vi.advanceTimersByTime(60_000);
    expect(b.tryAcquire()).toBe("probe");
    b.close();
    expect(b.tryAcquire()).toBe("pass");
    expect(b.remainingMs()).toBe(0);
  });
});

describe("CircuitBreaker — escalation and clamps", () => {
  it("doubles the open window on each consecutive trip", () => {
    const b = newBreaker();
    b.trip(60_000);
    expect(b.remainingMs()).toBe(60_000); // 2^0
    b.trip(60_000);
    expect(b.remainingMs()).toBe(120_000); // 2^1
    b.trip(60_000);
    expect(b.remainingMs()).toBe(240_000); // 2^2
  });

  it("floors a tiny Retry-After at minOpenMs so the probe has time to drain", () => {
    const b = newBreaker();
    b.trip(500); // below minOpenMs
    expect(b.remainingMs()).toBe(MIN_OPEN_MS);
  });

  it("caps the open window at maxOpenMs even for an absurd Retry-After", () => {
    const b = newBreaker();
    b.trip(100 * 60 * 60 * 1000); // 100h
    expect(b.remainingMs()).toBe(MAX_OPEN_MS);
  });

  it("caps escalation at 2^MAX_BACKOFF_EXPONENT (then maxOpenMs)", () => {
    const b = newBreaker();
    // Trip many times; the exponent saturates at 6 → 64×, then maxOpenMs.
    for (let i = 0; i < 12; i++) b.trip(1_000);
    // 1_000 * 2^6 = 64_000, which is below maxOpenMs, so the escalated
    // value (not the cap) governs and stops growing past the exponent cap.
    expect(b.remainingMs()).toBe(64_000);
  });
});

describe("CircuitBreaker — persistence & corruption handling on construction", () => {
  it("honors a still-active persisted window, clamped to maxOpenMs", () => {
    localStorage.setItem(
      SPOTIFY_CIRCUIT_OPEN_UNTIL_KEY,
      String(NOW + 100 * 60 * 60 * 1000), // 100h in the future (corrupt/hostile)
    );
    const b = newBreaker();
    expect(b.tryAcquire()).toBe("fail-fast");
    expect(b.remainingMs()).toBe(MAX_OPEN_MS); // clamped, can't deadlock
  });

  it("caps a corrupt persisted failure count so escalation can't overflow", () => {
    // Active window + an absurd failure count.
    localStorage.setItem(SPOTIFY_CIRCUIT_OPEN_UNTIL_KEY, String(NOW + 1_000));
    localStorage.setItem(SPOTIFY_CIRCUIT_FAILURE_COUNT_KEY, "999999");
    const b = newBreaker();
    vi.advanceTimersByTime(1_000); // window elapses → probe allowed
    expect(b.tryAcquire()).toBe("probe");
    b.releaseProbe();
    // Next trip uses the capped count (exponent saturated at 6), so the
    // window is 1_000 * 2^6, not an overflowed Infinity.
    b.trip(1_000);
    expect(b.remainingMs()).toBe(64_000);
  });

  it("keeps the escalation count when the window closed recently (rides out a hidden ban)", () => {
    // Window closed 1s ago (well within maxOpenMs) with count=3.
    localStorage.setItem(SPOTIFY_CIRCUIT_OPEN_UNTIL_KEY, String(NOW - 1_000));
    localStorage.setItem(SPOTIFY_CIRCUIT_FAILURE_COUNT_KEY, "3");
    const b = newBreaker();
    expect(b.tryAcquire()).toBe("pass"); // window already closed
    // The retained count means the next trip is trip #4 → 2^3 = 8×.
    b.trip(1_000);
    expect(b.remainingMs()).toBe(8_000);
  });

  it("decays a stale escalation count to trip #1 after a long idle", () => {
    // Window closed longer ago than maxOpenMs → the count is stale and must
    // not resume a days-old escalation on a single fresh 429.
    localStorage.setItem(
      SPOTIFY_CIRCUIT_OPEN_UNTIL_KEY,
      String(NOW - (MAX_OPEN_MS + 1_000)),
    );
    localStorage.setItem(SPOTIFY_CIRCUIT_FAILURE_COUNT_KEY, "6");
    const b = newBreaker();
    b.trip(1_000);
    expect(b.remainingMs()).toBe(MIN_OPEN_MS); // 2^0 = 1_000, floored to minOpenMs
  });

  it("ignores a non-numeric persisted timestamp (treats as no window)", () => {
    localStorage.setItem(SPOTIFY_CIRCUIT_OPEN_UNTIL_KEY, "not-a-number");
    expect(newBreaker().tryAcquire()).toBe("pass");
  });
});

describe("CircuitBreaker — reset", () => {
  it("reset() closes the breaker and clears an in-flight probe flag", () => {
    const b = newBreaker();
    b.trip(60_000);
    vi.advanceTimersByTime(60_000);
    expect(b.tryAcquire()).toBe("probe"); // probeInFlight = true
    b.reset();
    // After reset the breaker is fully closed — a fresh caller passes
    // rather than being told a probe is already in flight.
    expect(b.tryAcquire()).toBe("pass");
  });
});
