import { describe, expect, it } from "vitest";
import { formatDuration } from "./duration";

// formatDuration is the shared `mm:ss` formatter (no hour support — it
// floors total minutes, so 90 min renders "90:00", not "1:30:00"). It
// rounds to the nearest second and returns the em-dash sentinel "—" for
// anything that isn't a finite, non-negative number.

describe("formatDuration", () => {
  it("formats a sub-minute duration with zero-padded seconds", () => {
    expect(formatDuration(5_000)).toBe("0:05");
  });

  it("formats zero as 0:00", () => {
    // 0 is a valid duration (e.g. an unknown-length track stored as 0),
    // NOT a missing value — it must render, not fall back to the dash.
    expect(formatDuration(0)).toBe("0:00");
  });

  it("rounds to the nearest second at the mm:ss boundary (59500ms → 1:00)", () => {
    // 59.5s rounds up to 60s, which carries into the minutes column.
    expect(formatDuration(59_500)).toBe("1:00");
  });

  it("rounds down just below the half-second boundary (59499ms → 0:59)", () => {
    expect(formatDuration(59_499)).toBe("0:59");
  });

  it("formats a multi-minute duration", () => {
    // 3:45 = 225_000ms.
    expect(formatDuration(225_000)).toBe("3:45");
  });

  it("does not switch to an h:mm:ss form past 60 minutes (no hour support)", () => {
    // Contract pin: minutes are NOT wrapped into hours — 90 minutes
    // renders as "90:00".
    expect(formatDuration(90 * 60 * 1000)).toBe("90:00");
  });

  it("returns the dash sentinel for undefined", () => {
    expect(formatDuration(undefined)).toBe("—");
  });

  it("returns the dash sentinel for null", () => {
    expect(formatDuration(null)).toBe("—");
  });

  it("returns the dash sentinel for a negative duration", () => {
    expect(formatDuration(-1)).toBe("—");
  });

  it("returns the dash sentinel for NaN / Infinity", () => {
    expect(formatDuration(Number.NaN)).toBe("—");
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe("—");
  });
});
