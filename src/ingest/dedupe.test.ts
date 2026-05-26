import { describe, expect, it } from "vitest";
import { dedupeFiles } from "./dedupe";

// `dedupeFiles` only inspects `name` and `size`, so we cast a minimal shim
// rather than depend on the runtime `File` constructor (which is environment-
// specific and produces a heavyweight object we don't need here).
function makeFile(name: string, size: number): File {
  return { name, size } as unknown as File;
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
});
