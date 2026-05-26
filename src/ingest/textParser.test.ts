import { describe, expect, it } from "vitest";
import { parseTextContent } from "./textParser";

describe("parseTextContent", () => {
  it("treats single line as title", () => {
    const tracks = parseTextContent("Stargazer");
    expect(tracks).toHaveLength(1);
    expect(tracks[0].title).toBe("Stargazer");
  });

  it("splits Artist - Title", () => {
    const tracks = parseTextContent("Radiohead - Karma Police");
    expect(tracks[0]).toMatchObject({
      artist: "Radiohead",
      title: "Karma Police",
    });
  });

  it("splits Artist - Album - Title", () => {
    const tracks = parseTextContent("Radiohead - OK Computer - Karma Police");
    expect(tracks[0]).toMatchObject({
      artist: "Radiohead",
      album: "OK Computer",
      title: "Karma Police",
    });
  });

  it("ignores blank lines and comments", () => {
    const tracks = parseTextContent("# header\n\nFoo\n# trailing");
    expect(tracks).toHaveLength(1);
    expect(tracks[0].title).toBe("Foo");
  });
});
