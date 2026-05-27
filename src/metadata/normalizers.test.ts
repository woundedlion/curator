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

  it("strips ft. (with period)", () => {
    expect(normalizeForMatching("Lean On ft. MØ")).toBe("lean on");
  });

  it("strips bare ft (no period) — common in ID3 tags", () => {
    expect(normalizeForMatching("Lean On ft MØ")).toBe("lean on");
  });

  it("strips feat (no period)", () => {
    expect(normalizeForMatching("Yeah! feat Ludacris")).toBe("yeah!");
  });

  it("strips featuring (full word)", () => {
    expect(normalizeForMatching("Stan featuring Dido")).toBe("stan");
  });

  it("does not strip 'feat' when no trailing artist clause", () => {
    // The clause needs at least one trailing token after the keyword;
    // a song titled just "feat" or "Feature" shouldn't be eaten.
    expect(normalizeForMatching("Feature")).toBe("feature");
  });

  it("expands ampersands and casefolds", () => {
    expect(normalizeForMatching("Hall & Oates")).toBe("hall and oates");
  });

  it("returns empty string for nullish input", () => {
    expect(normalizeForMatching(undefined)).toBe("");
    expect(normalizeForMatching("")).toBe("");
  });

  it("strips combining diacritics", () => {
    // NFKD decomposes "é" → "e" + U+0301; the combining mark gets dropped.
    expect(normalizeForMatching("café")).toBe("cafe");
    expect(normalizeForMatching("Beyoncé")).toBe("beyonce");
    expect(normalizeForMatching("Mötley Crüe")).toBe("motley crue");
  });

  it("strips zero-width characters and BOM", () => {
    expect(normalizeForMatching("﻿Radiohead")).toBe("radiohead");
    expect(normalizeForMatching("​Foo‌Bar")).toBe("foobar");
  });

  it("strips Unicode bidi marks", () => {
    expect(normalizeForMatching("‎Song‏")).toBe("song");
  });

  it("folds smart/curly quotes to ASCII", () => {
    expect(normalizeForMatching("Don’t Stop")).toBe("don't stop");
    expect(normalizeForMatching("“Hello”")).toBe('"hello"');
  });

  it("normalizes non-breaking space to plain space", () => {
    expect(normalizeForMatching("Pink Floyd")).toBe("pink floyd");
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
