import { describe, expect, it } from "vitest";
import { dedupeFiles } from "./dedupe";

// `dedupeFiles` inspects `name`, `size`, and `lastModified`. Cast a minimal
// shim rather than depend on the runtime `File` constructor (which is
// environment-specific and produces a heavyweight object we don't need
// here).
function makeFile(name: string, size: number, lastModified = 0): File {
  return { name, size, lastModified } as unknown as File;
}

describe("dedupeFiles", () => {
  it("returns the input verbatim when no duplicates are present", () => {
    const files = [
      makeFile("a.mp3", 100),
      makeFile("b.mp3", 200),
      makeFile("c.mp3", 300),
    ];
    expect(dedupeFiles(files).map((f) => f.name)).toEqual(["a.mp3", "b.mp3", "c.mp3"]);
  });

  it("drops files with the same name+size as an earlier entry", () => {
    const files = [
      makeFile("a.mp3", 100),
      makeFile("a.mp3", 100), // exact duplicate
      makeFile("b.mp3", 200),
    ];
    const out = dedupeFiles(files);
    expect(out).toHaveLength(2);
    expect(out.map((f) => f.name)).toEqual(["a.mp3", "b.mp3"]);
  });

  it("keeps files that share a name but differ in size", () => {
    const files = [
      makeFile("song.mp3", 100),
      makeFile("song.mp3", 200),
    ];
    expect(dedupeFiles(files)).toHaveLength(2);
  });

  it("keeps files that share a size but differ in name", () => {
    const files = [
      makeFile("song-a.mp3", 100),
      makeFile("song-b.mp3", 100),
    ];
    expect(dedupeFiles(files)).toHaveLength(2);
  });

  it("preserves the order of the first occurrence", () => {
    const files = [
      makeFile("b.mp3", 200),
      makeFile("a.mp3", 100),
      makeFile("b.mp3", 200), // duplicate of first
      makeFile("c.mp3", 300),
    ];
    expect(dedupeFiles(files).map((f) => f.name)).toEqual([
      "b.mp3",
      "a.mp3",
      "c.mp3",
    ]);
  });

  it("returns an empty array for empty input", () => {
    expect(dedupeFiles([])).toEqual([]);
  });

  it("keeps files that share name+size but differ in lastModified", () => {
    // Two genuinely different MP3s with the same filename and byte count
    // — common for re-rips of the same album at the same bitrate from
    // different sources. The lastModified disambiguates without a hash.
    const files = [
      makeFile("song.mp3", 100, 1_700_000_000_000),
      makeFile("song.mp3", 100, 1_700_000_001_000),
    ];
    expect(dedupeFiles(files)).toHaveLength(2);
  });

  it("collapses files whose name+size+lastModified all match", () => {
    const files = [
      makeFile("song.mp3", 100, 1_700_000_000_000),
      makeFile("song.mp3", 100, 1_700_000_000_000),
    ];
    expect(dedupeFiles(files)).toHaveLength(1);
  });

  it("does not collide across field boundaries (cross-field key safety)", () => {
    // Without a delimiter byte, ("a.mp3", 12, 345) and ("a.mp", 312, 345)
    // would both serialize to "a.mp312345". Regression guard.
    const files = [
      makeFile("a.mp3", 12, 345),
      makeFile("a.mp", 312, 345),
    ];
    expect(dedupeFiles(files)).toHaveLength(2);
  });
});
