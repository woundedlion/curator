import { describe, expect, it } from "vitest";
import { parseTextContent } from "./textParser";

describe("parseTextContent", () => {
  it("treats single line as title", () => {
    const tracks = parseTextContent("Stargazer");
    expect(tracks).toHaveLength(1);
    expect(tracks[0]!.title).toBe("Stargazer");
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

  it("splits Album - Track# - Artist - Title (four segments, track at -3)", () => {
    // Mirrors the filename heuristic: a track-number-looking segment is
    // detected and the line does NOT collapse into album/artist/title only.
    const tracks = parseTextContent("Dancehall 1 - 15 - Buju Banton - Love Sponge");
    expect(tracks[0]).toMatchObject({
      trackNo: 15,
      album: "Dancehall 1",
      artist: "Buju Banton",
      title: "Love Sponge",
    });
  });

  it("splits Artist - Album - TrackNo - Title (four segments, track at -2)", () => {
    // The aligned case from FIX 2: the text parser must detect the
    // embedded track number exactly like the filename heuristic, so
    // "Radiohead - In Rainbows - 03 - Nude" parses the same in both.
    const tracks = parseTextContent("Radiohead - In Rainbows - 03 - Nude");
    expect(tracks[0]).toMatchObject({
      trackNo: 3,
      artist: "Radiohead",
      album: "In Rainbows",
      title: "Nude",
    });
  });

  it("ignores blank lines and comments", () => {
    const tracks = parseTextContent("# header\n\nFoo\n# trailing");
    expect(tracks).toHaveLength(1);
    expect(tracks[0]!.title).toBe("Foo");
  });

  it("strips a leading UTF-8 BOM", () => {
    // Notepad on Windows saves with U+FEFF at the start; without
    // stripping, the first artist becomes "<U+FEFF>Radiohead".
    const tracks = parseTextContent("﻿" + "Radiohead - Karma Police");
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
