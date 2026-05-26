import { describe, expect, it } from "vitest";
import { normalizeForMatching, normalizeForLuceneLiteral } from "./normalizers";

describe("normalizeForMatching", () => {
  it("strips parenthetical suffixes", () => {
    expect(normalizeForMatching("Karma Police (Remastered 2017)")).toBe(
      "karma police",
    );
  });

  it("strips nested bracket suffixes", () => {
    expect(normalizeForMatching("Stargazer [Live] (Edit)")).toBe("stargazer");
  });

  it("strips featuring clauses", () => {
    expect(normalizeForMatching("Yeah! feat. Lil Jon & Ludacris")).toBe(
      "yeah!",
    );
  });

  it("expands ampersands and casefolds", () => {
    expect(normalizeForMatching("Hall & Oates")).toBe("hall and oates");
  });

  it("returns empty string for nullish input", () => {
    expect(normalizeForMatching(undefined)).toBe("");
    expect(normalizeForMatching("")).toBe("");
  });
});

describe("normalizeForLuceneLiteral", () => {
  it("escapes double quotes", () => {
    expect(normalizeForLuceneLiteral('Don\'t Say "Goodbye"')).toBe(
      'Don\'t Say \\"Goodbye\\"',
    );
  });

  it("strips parentheticals but preserves case", () => {
    expect(normalizeForLuceneLiteral("OK Computer (Deluxe)")).toBe(
      "OK Computer",
    );
  });

  it("returns empty for nullish input", () => {
    expect(normalizeForLuceneLiteral(undefined)).toBe("");
  });
});
