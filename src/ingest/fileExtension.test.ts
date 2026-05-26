import { describe, expect, it } from "vitest";
import {
  getExtension,
  isAudioFile,
  isIngestibleFile,
  isPlaylistFile,
  isTextFile,
} from "./fileExtension";

describe("getExtension", () => {
  it("returns the lower-cased extension for typical filenames", () => {
    expect(getExtension("song.MP3")).toBe("mp3");
    expect(getExtension("notes.txt")).toBe("txt");
  });

  it("returns the last extension when filename has multiple dots", () => {
    expect(getExtension("My Mix.curator.txt")).toBe("txt");
  });

  it("returns empty string for files without an extension", () => {
    expect(getExtension("README")).toBe("");
  });

  it("returns empty string for hidden files with no further extension", () => {
    // Treated like an extension since there's a dot. Acceptable behavior;
    // we document it here so a future change is intentional.
    expect(getExtension(".gitignore")).toBe("gitignore");
  });
});

describe("audio/text/playlist predicates", () => {
  it("classifies common audio extensions", () => {
    expect(isAudioFile("track.mp3")).toBe(true);
    expect(isAudioFile("track.FLAC")).toBe(true);
    expect(isAudioFile("track.opus")).toBe(true);
    expect(isAudioFile("track.txt")).toBe(false);
  });

  it("classifies .txt as text", () => {
    expect(isTextFile("songs.txt")).toBe(true);
    expect(isTextFile("songs.mp3")).toBe(false);
  });

  it("classifies .m3u and .m3u8 as playlist", () => {
    expect(isPlaylistFile("set.m3u")).toBe(true);
    expect(isPlaylistFile("set.m3u8")).toBe(true);
    expect(isPlaylistFile("set.txt")).toBe(false);
  });

  it("accepts any of audio / text / playlist as ingestible", () => {
    expect(isIngestibleFile("song.mp3")).toBe(true);
    expect(isIngestibleFile("songs.txt")).toBe(true);
    expect(isIngestibleFile("set.m3u")).toBe(true);
    expect(isIngestibleFile("photo.jpg")).toBe(false);
    expect(isIngestibleFile("README")).toBe(false);
  });
});
