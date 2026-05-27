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

  it("strips a leading UTF-8 BOM", () => {
    // Notepad on Windows saves with `﻿` at the start; without
    // stripping, the first artist becomes `﻿Radiohead`.
    const tracks = parseTextContent("﻿Radiohead - Karma Police");
    expect(tracks[0]).toMatchObject({
      artist: "Radiohead",
      title: "Karma Police",
    });
  });

  it("handles CR-only line endings (classic Mac files)", () => {
    const tracks = parseTextContent("A\rB\rC");
    expect(tracks.map((t) => t.title)).toEqual(["A", "B", "C"]);
  });

  it("handles mixed CRLF / CR / LF line endings", () => {
    const tracks = parseTextContent("A\r\nB\rC\nD");
    expect(tracks.map((t) => t.title)).toEqual(["A", "B", "C", "D"]);
  });
});
