import { describe, expect, it } from "vitest";
import { parseRetryAfter } from "./apiClient";

describe("parseRetryAfter", () => {
  it("parses integer seconds", () => {
    expect(parseRetryAfter("5")).toBe(5_000);
  });

  it("parses zero seconds as the 1-second floor", () => {
    expect(parseRetryAfter("0")).toBe(1_000);
  });

  it("parses an HTTP-date relative to now", () => {
    const now = 1_700_000_000_000;
    const tenSecondsLater = new Date(now + 10_000).toUTCString();
    expect(parseRetryAfter(tenSecondsLater, now)).toBeGreaterThanOrEqual(
      9_000,
    );
    expect(parseRetryAfter(tenSecondsLater, now)).toBeLessThanOrEqual(
      11_000,
    );
  });

  it("clamps a far-future HTTP-date to MAX_RETRY_AFTER_MS (12 hours)", () => {
    const now = 1_700_000_000_000;
    const farFuture = new Date(now + 365 * 24 * 60 * 60 * 1000).toUTCString();
    expect(parseRetryAfter(farFuture, now)).toBe(12 * 60 * 60 * 1000);
  });

  it("clamps a huge integer to MAX_RETRY_AFTER_MS (12 hours)", () => {
    // Real-world incidents: Retry-After: 12225 (~3.4h) and 42578 (~12h).
    // The cap was raised from 1h to 12h after observing Spotify-issued
    // multi-hour bans hidden behind CORS — clamping to 1h was making
    // the breaker probe back into an active ban every hour.
    expect(parseRetryAfter("12225")).toBe(12225 * 1000); // within cap
    expect(parseRetryAfter("999999")).toBe(12 * 60 * 60 * 1000); // capped
  });

  it("honors a realistic Spotify Retry-After value within the cap", () => {
    // 5-minute penalty — typical for a hit on the rolling window.
    expect(parseRetryAfter("300")).toBe(300_000);
  });

  it("returns the 10-minute default for a missing header", () => {
    // Spotify often hides Retry-After via CORS even when it's present
    // on the wire (incidents shipped 82,752s = ~23h). When no value is
    // readable we fall back to a 10-minute lockout — long enough to
    // break the retry-into-ban loop on a hidden multi-hour penalty.
    // When a real value IS present (the cases above) we honor it.
    expect(parseRetryAfter(null)).toBe(10 * 60 * 1000);
  });

  it("returns the 10-minute default for an unparseable header", () => {
    expect(parseRetryAfter("not a number, not a date")).toBe(10 * 60 * 1000);
  });

  it("returns at least the 1-second floor for an HTTP-date in the past", () => {
    const now = 1_700_000_000_000;
    const past = new Date(now - 60_000).toUTCString();
    expect(parseRetryAfter(past, now)).toBeGreaterThanOrEqual(1_000);
  });

  it("rejects non-numeric strings even if they start with digits", () => {
    // "5xx" would parseInt to 5; the strict-digits regex forces fall-through.
    expect(parseRetryAfter("5xx")).toBe(10 * 60 * 1000);
  });

  it("trims surrounding whitespace before parsing", () => {
    expect(parseRetryAfter("  42  ")).toBe(42_000);
  });
});
