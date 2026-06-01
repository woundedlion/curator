import { describe, expect, it } from "vitest";
import {
  MIN_AUTO_MATCH_TITLE_SIMILARITY,
  titleSimilarity,
} from "./titleSimilarity";

describe("titleSimilarity", () => {
  it("returns 1 for identical strings (after normalization)", () => {
    expect(titleSimilarity("Karma Police", "karma police")).toBe(1);
  });

  it("returns 0 when either input is missing or empty", () => {
    expect(titleSimilarity(undefined, "x")).toBe(0);
    expect(titleSimilarity("x", undefined)).toBe(0);
    expect(titleSimilarity("", "x")).toBe(0);
  });

  it("normalizes parenthetical / featuring noise before comparing", () => {
    expect(titleSimilarity("Karma Police (Remastered 2017)", "Karma Police")).toBe(1);
    expect(titleSimilarity("Yeah! feat. Lil Jon", "Yeah!")).toBe(1);
  });

  it("uses substring containment for one-sided matches", () => {
    const score = titleSimilarity("Lovesponge", "Love Sponge Extended");
    // strip whitespace: 'lovesponge' (10) vs 'lovespongeextended' (18) -> 10/18.
    expect(score).toBeCloseTo(10 / 18, 5);
  });

  it("treats single-character inputs as all-or-nothing", () => {
    expect(titleSimilarity("a", "a")).toBe(1);
    expect(titleSimilarity("a", "b")).toBe(0);
  });

  it("falls back to bigram Jaccard for partial matches", () => {
    // Different but overlapping titles. Score should be > 0 and < 1.
    const score = titleSimilarity("Stargazer", "Stargazers");
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThanOrEqual(1);
  });

  it("returns 0 for fully disjoint titles", () => {
    expect(titleSimilarity("xxxx", "yyyy")).toBe(0);
  });

  it("scores a short coincidental substring BELOW auto-match (precision)", () => {
    // "Live" is a contiguous substring of "Alive", but they are different
    // titles. The old code returned 4/5 = 0.8 via the containment branch;
    // the length gate now forces it through the blended signal, which
    // lands it below the auto-match threshold.
    const score = titleSimilarity("Live", "Alive");
    expect(score).toBeLessThan(MIN_AUTO_MATCH_TITLE_SIMILARITY);
  });

  it("scores word reorderings BELOW auto-match (order sensitivity)", () => {
    // "Karma Police" vs "Police Karma" share every word but in a
    // different order. The old whitespace-stripped bigram Jaccard scored
    // them ~0.69 (near-identical); the order-sensitive word signal now
    // pushes the reordering below the auto-match threshold.
    const score = titleSimilarity("Karma Police", "Police Karma");
    expect(score).toBeLessThan(MIN_AUTO_MATCH_TITLE_SIMILARITY);
  });

  it("keeps true subset / reorder-free matches AT OR ABOVE auto-match", () => {
    // Sanity floor for the true positives the gate must not regress.
    expect(
      titleSimilarity("Yeah! feat. Lil Jon", "Yeah!"),
    ).toBeGreaterThanOrEqual(MIN_AUTO_MATCH_TITLE_SIMILARITY);
    expect(
      titleSimilarity("Lovesponge", "Love Sponge Extended"),
    ).toBeGreaterThanOrEqual(MIN_AUTO_MATCH_TITLE_SIMILARITY);
    expect(
      titleSimilarity("Stargazer", "Stargazers"),
    ).toBeGreaterThanOrEqual(MIN_AUTO_MATCH_TITLE_SIMILARITY);
  });

  it("publishes a documented auto-match threshold", () => {
    expect(MIN_AUTO_MATCH_TITLE_SIMILARITY).toBe(0.4);
  });
});
