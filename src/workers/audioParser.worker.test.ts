// Unit tests for the pure tag-sanitizing helpers in the audio-parser
// worker. These guards are high-value: music-metadata surfaces NaN /
// Infinity / out-of-range junk from malformed ID3/Vorbis frames verbatim,
// and without these filters that garbage would poison Track fields used
// in sort/scoring/UI. The worker module's top-level message wiring is
// guarded by a `typeof self` check, so importing it here (under the node
// test env, where there is no worker `self`) is a no-op that doesn't run
// any message handler.
import { describe, expect, it } from "vitest";
import {
  durationToMs,
  sanePosition,
  saneYear,
} from "./audioParser.worker";

describe("durationToMs", () => {
  it("accepts finite non-negative durations and converts seconds to ms", () => {
    expect(durationToMs(0)).toBe(0);
    expect(durationToMs(1)).toBe(1000);
    expect(durationToMs(123.456)).toBe(123456); // rounded
    expect(durationToMs(0.0005)).toBe(1); // rounds up
  });

  it("rejects undefined", () => {
    expect(durationToMs(undefined)).toBeUndefined();
  });

  it("rejects NaN and Infinity", () => {
    expect(durationToMs(Number.NaN)).toBeUndefined();
    expect(durationToMs(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(durationToMs(Number.NEGATIVE_INFINITY)).toBeUndefined();
  });

  it("rejects negative durations", () => {
    expect(durationToMs(-1)).toBeUndefined();
    expect(durationToMs(-0.001)).toBeUndefined();
  });
});

describe("sanePosition", () => {
  it("accepts plausible positive integer positions", () => {
    expect(sanePosition(1)).toBe(1);
    expect(sanePosition(7)).toBe(7);
    expect(sanePosition(99)).toBe(99);
  });

  it("rejects zero and negatives", () => {
    expect(sanePosition(0)).toBeUndefined();
    expect(sanePosition(-1)).toBeUndefined();
    expect(sanePosition(-5)).toBeUndefined();
  });

  it("rejects non-integers", () => {
    expect(sanePosition(1.5)).toBeUndefined();
    expect(sanePosition(2.0001)).toBeUndefined();
  });

  it("rejects NaN and Infinity", () => {
    expect(sanePosition(Number.NaN)).toBeUndefined();
    expect(sanePosition(Number.POSITIVE_INFINITY)).toBeUndefined();
  });

  it("rejects non-number values", () => {
    expect(sanePosition(undefined)).toBeUndefined();
    expect(sanePosition(null)).toBeUndefined();
    expect(sanePosition("3")).toBeUndefined();
    expect(sanePosition({})).toBeUndefined();
  });
});

describe("saneYear", () => {
  it("accepts plausible release years within [1860, 2200]", () => {
    expect(saneYear(1860)).toBe(1860); // lower bound inclusive
    expect(saneYear(1969)).toBe(1969);
    expect(saneYear(2024)).toBe(2024);
    expect(saneYear(2200)).toBe(2200); // upper bound inclusive
  });

  it("rejects years below the lower bound", () => {
    expect(saneYear(1859)).toBeUndefined();
    expect(saneYear(0)).toBeUndefined();
    expect(saneYear(-1)).toBeUndefined();
  });

  it("rejects years above the upper bound, including 5-digit junk", () => {
    expect(saneYear(2201)).toBeUndefined();
    expect(saneYear(99999)).toBeUndefined();
  });

  it("rejects non-integers", () => {
    expect(saneYear(1999.5)).toBeUndefined();
  });

  it("rejects NaN, Infinity, and non-number values", () => {
    expect(saneYear(Number.NaN)).toBeUndefined();
    expect(saneYear(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(saneYear(undefined)).toBeUndefined();
    expect(saneYear(null)).toBeUndefined();
    expect(saneYear("2020")).toBeUndefined();
  });
});
