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

  it("clamps a far-future HTTP-date to MAX_RETRY_AFTER_MS (1 hour)", () => {
    const now = 1_700_000_000_000;
    const farFuture = new Date(now + 365 * 24 * 60 * 60 * 1000).toUTCString();
    expect(parseRetryAfter(farFuture, now)).toBe(60 * 60 * 1000);
  });

  it("clamps a huge integer to MAX_RETRY_AFTER_MS (1 hour)", () => {
    // The real-world incident was Retry-After: 12225 (~3.4 hours).
    // We honor up to 1 hour so the wait isn't comically long.
    expect(parseRetryAfter("12225")).toBe(60 * 60 * 1000);
    expect(parseRetryAfter("999999")).toBe(60 * 60 * 1000);
  });

  it("honors a realistic Spotify Retry-After value within the cap", () => {
    // 5-minute penalty — typical for a hit on the rolling window.
    expect(parseRetryAfter("300")).toBe(300_000);
  });

  it("returns the 30-second default for a missing header", () => {
    // Spotify often omits Retry-After on the first 429. Defaulting to
    // 1s used to fall under the 30-second window and earn a bigger
    // penalty on the retry.
    expect(parseRetryAfter(null)).toBe(30_000);
  });

  it("returns the 30-second default for an unparseable header", () => {
    expect(parseRetryAfter("not a number, not a date")).toBe(30_000);
  });

  it("returns at least the 1-second floor for an HTTP-date in the past", () => {
    const now = 1_700_000_000_000;
    const past = new Date(now - 60_000).toUTCString();
    expect(parseRetryAfter(past, now)).toBeGreaterThanOrEqual(1_000);
  });

  it("rejects non-numeric strings even if they start with digits", () => {
    // "5xx" would parseInt to 5; the strict-digits regex forces fall-through.
    expect(parseRetryAfter("5xx")).toBe(30_000);
  });

  it("trims surrounding whitespace before parsing", () => {
    expect(parseRetryAfter("  42  ")).toBe(42_000);
  });
});
