// Tests for parseAudioFile — the consumer that merges worker-parsed
// ID3/container fields with the filename heuristic into a Track. The
// worker pool is mocked so we can drive both the parsed-fields and the
// parse-failure paths; the real filename heuristic is exercised so the
// ID3-vs-filename precedence is pinned end-to-end.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { ParsedFields } from "../workers/audioParser.worker";

const parseAudioInPool = vi.fn<(file: File) => Promise<ParsedFields>>();

vi.mock("../workers/audioParserPool", () => ({
  parseAudioInPool: (file: File) => parseAudioInPool(file),
}));

import { parseAudioFile } from "./audioParser";

function audioFile(name: string): File {
  return new File([new Uint8Array([1])], name, { type: "audio/mpeg" });
}

afterEach(() => {
  parseAudioInPool.mockReset();
  vi.restoreAllMocks();
});

describe("parseAudioFile — ID3 vs filename precedence", () => {
  it("prefers ID3 title/artist/album over the filename heuristic", async () => {
    parseAudioInPool.mockResolvedValue({
      title: "Tag Title",
      artist: "Tag Artist",
      album: "Tag Album",
    });
    const track = await parseAudioFile(
      audioFile("File Artist - File Title.mp3"),
    );
    expect(track.title).toBe("Tag Title");
    expect(track.artist).toBe("Tag Artist");
    expect(track.album).toBe("Tag Album");
  });

  it("falls back to filename fields when an ID3 field is blank", async () => {
    parseAudioInPool.mockResolvedValue({ title: "   ", artist: "" });
    const track = await parseAudioFile(
      audioFile("Radiohead - Karma Police.mp3"),
    );
    // Blank ID3 strings collapse to undefined, so the filename hint wins.
    expect(track.title).toBe("Karma Police");
    expect(track.artist).toBe("Radiohead");
  });

  it("uses albumartist as the artist when artist is absent", async () => {
    parseAudioInPool.mockResolvedValue({
      title: "T",
      albumartist: "Various Artists",
    });
    const track = await parseAudioFile(audioFile("x.mp3"));
    expect(track.artist).toBe("Various Artists");
    expect(track.albumArtist).toBe("Various Artists");
  });

  it("prefers an ID3 track number over the filename-derived one", async () => {
    parseAudioInPool.mockResolvedValue({ title: "T", trackNo: 7 });
    const track = await parseAudioFile(audioFile("03 - Artist - T.mp3"));
    expect(track.trackNo).toBe(7);
  });

  it("falls back to the filename track number when ID3 lacks one", async () => {
    parseAudioInPool.mockResolvedValue({ title: "T" });
    const track = await parseAudioFile(audioFile("03 - Artist - T.mp3"));
    expect(track.trackNo).toBe(3);
  });
});

describe("parseAudioFile — altQuery / altQueryIfDifferent", () => {
  it("sets altQuery to the filename fields when they differ from the primary", async () => {
    // ID3 wins for the primary fields, but the filename disagrees, so the
    // filename interpretation is preserved as a fallback search query.
    parseAudioInPool.mockResolvedValue({
      title: "Tag Title",
      artist: "Tag Artist",
    });
    const track = await parseAudioFile(
      audioFile("File Artist - File Title.mp3"),
    );
    expect(track.altQuery).toEqual({
      title: "File Title",
      artist: "File Artist",
    });
  });

  it("omits altQuery when filename and ID3 agree (case-insensitively)", async () => {
    parseAudioInPool.mockResolvedValue({
      title: "karma police",
      artist: "RADIOHEAD",
    });
    const track = await parseAudioFile(
      audioFile("Radiohead - Karma Police.mp3"),
    );
    expect(track.altQuery).toBeUndefined();
  });

  it("omits altQuery when the filename yields no usable title/artist", async () => {
    // A single-segment filename gives only a title equal to the primary
    // (from ID3), so there's nothing distinct to fall back to.
    parseAudioInPool.mockResolvedValue({ title: "Stargazer", artist: "Rainbow" });
    const track = await parseAudioFile(audioFile("Stargazer.mp3"));
    // filename title == primary title; filename has no artist → no alt.
    expect(track.altQuery).toBeUndefined();
  });
});

describe("parseAudioFile — parse-failure fallback", () => {
  it("falls back to filename-only when the worker rejects", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    parseAudioInPool.mockRejectedValue(new Error("corrupt container"));

    const track = await parseAudioFile(
      audioFile("Radiohead - OK Computer - Karma Police.mp3"),
    );

    expect(track.artist).toBe("Radiohead");
    expect(track.album).toBe("OK Computer");
    expect(track.title).toBe("Karma Police");
    // The row is kept, but the failure surfaces for diagnosis.
    expect(warn).toHaveBeenCalled();
    // No ID3-only fields leak through on the fallback path.
    expect(track.altQuery).toBeUndefined();
    expect(track.durationMs).toBeUndefined();
  });
});
