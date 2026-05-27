import { describe, expect, it } from "vitest";
import {
  buildClientParam,
  buildPermissiveQuery,
  buildUserAgent,
} from "./musicbrainzClient";

describe("buildPermissiveQuery", () => {
  it("strips Lucene field prefixes and quotes", () => {
    expect(
      buildPermissiveQuery('recording:"Karma Police" AND artist:"Radiohead"'),
    ).toBe("Karma Police Radiohead");
  });

  it("strips an escape pair before bare quotes (no orphan backslash)", () => {
    // Title with an embedded double-quote: She Said \"Yes\"
    expect(
      buildPermissiveQuery('recording:"She Said \\"Yes\\""'),
    ).toBe("She Said Yes");
  });

  it("preserves the literal word AND inside a title", () => {
    // Lucene's AND operator must have whitespace on both sides — the
    // word "AND" mid-token (e.g. "WALK AND DON'T LOOK BACK" used as a
    // title token) should survive.
    expect(buildPermissiveQuery('recording:"WALK AND DON\'T LOOK BACK"'))
      .toContain("WALK");
    expect(buildPermissiveQuery('recording:"WALK AND DON\'T LOOK BACK"'))
      .toContain("DON'T");
    expect(buildPermissiveQuery('recording:"WALK AND DON\'T LOOK BACK"'))
      .toContain("LOOK");
    expect(buildPermissiveQuery('recording:"WALK AND DON\'T LOOK BACK"'))
      .toContain("BACK");
  });

  it("strips the AND operator between clauses", () => {
    expect(
      buildPermissiveQuery("recording:Foo AND artist:Bar"),
    ).toBe("Foo Bar");
  });

  it("collapses whitespace", () => {
    expect(buildPermissiveQuery('  foo   bar    baz  ')).toBe("foo bar baz");
  });

  it("returns empty string for empty input", () => {
    expect(buildPermissiveQuery("")).toBe("");
  });
});

describe("buildClientParam", () => {
  it("uses dash-separated form acceptable to MB's client= param", () => {
    expect(buildClientParam("alice@example.com")).toMatch(
      /^Curator-\d/,
    );
  });

  it("sanitizes characters not allowed in the client param", () => {
    // The client= param expects [A-Za-z0-9._-] only — characters like @
    // would otherwise corrupt the URL encoding. They should be replaced
    // with an underscore so the value remains parseable.
    const value = buildClientParam("alice+bob@example.com");
    expect(value).not.toContain("@");
    expect(value).not.toContain("+");
    expect(value).toContain("alice");
    expect(value).toContain("example.com");
  });
});

describe("buildUserAgent", () => {
  it("uses the MB-recommended bracketed contact form", () => {
    expect(buildUserAgent("alice@example.com")).toBe(
      `Curator/0.1.0 ( alice@example.com )`,
    );
  });
});
