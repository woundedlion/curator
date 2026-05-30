// Tests for ingestFiles — the producer-side fan-out that routes each
// dropped file to the right parser by extension, aggregates per-file
// failures without sinking the batch, and reports progress. The three
// concrete parsers (audio/m3u/text) are mocked so routing and the
// failure/progress contracts can be driven deterministically; the real
// fileExtension routing is exercised. dedupe is stubbed to identity so a
// file's name/size/mtime quirks don't silently collapse fixtures.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Track } from "../types";

const parseAudioFile = vi.fn();
const parseM3uFile = vi.fn();
const parseTextFile = vi.fn();

vi.mock("../metadata/audioParser", () => ({
  parseAudioFile: (file: File) => parseAudioFile(file),
}));
vi.mock("./m3uParser", () => ({
  parseM3uFile: (file: File) => parseM3uFile(file),
}));
vi.mock("./textParser", () => ({
  parseTextFile: (file: File) => parseTextFile(file),
}));
vi.mock("./dedupe", () => ({
  dedupeFiles: (files: File[]) => files,
}));

import { ingestFiles } from "./ingestPipeline";

function file(name: string): File {
  return new File([new Uint8Array([0])], name, { type: "application/octet-stream" });
}

function track(title: string): Track {
  return {
    id: title,
    source: { kind: "file", fileName: title },
    title,
    enrichment: { status: "idle" },
    spotify: { status: "idle" },
  };
}

afterEach(() => {
  parseAudioFile.mockReset();
  parseM3uFile.mockReset();
  parseTextFile.mockReset();
});

describe("ingestFiles", () => {
  it("routes each file to the parser matching its extension", async () => {
    parseAudioFile.mockResolvedValue(track("audio"));
    parseM3uFile.mockResolvedValue([track("m3u")]);
    parseTextFile.mockResolvedValue([track("text")]);

    const result = await ingestFiles([
      file("song.mp3"),
      file("list.m3u"),
      file("notes.txt"),
    ]);

    expect(parseAudioFile).toHaveBeenCalledTimes(1);
    expect(parseAudioFile.mock.calls[0]![0].name).toBe("song.mp3");
    expect(parseM3uFile).toHaveBeenCalledTimes(1);
    expect(parseM3uFile.mock.calls[0]![0].name).toBe("list.m3u");
    expect(parseTextFile).toHaveBeenCalledTimes(1);
    expect(parseTextFile.mock.calls[0]![0].name).toBe("notes.txt");

    expect(result.tracks.map((t) => t.title).sort()).toEqual([
      "audio",
      "m3u",
      "text",
    ]);
    expect(result.failures).toEqual([]);
  });

  it("ignores files with an unrecognized extension (no parser, no failure)", async () => {
    const result = await ingestFiles([file("cover.jpg")]);
    expect(parseAudioFile).not.toHaveBeenCalled();
    expect(parseM3uFile).not.toHaveBeenCalled();
    expect(parseTextFile).not.toHaveBeenCalled();
    expect(result.tracks).toEqual([]);
    expect(result.failures).toEqual([]);
  });

  it("aggregates a per-file failure without sinking the rest of the batch", async () => {
    parseAudioFile.mockResolvedValue(track("good"));
    parseTextFile.mockRejectedValue(new Error("bad file"));

    const result = await ingestFiles([file("good.mp3"), file("broken.txt")]);

    expect(result.tracks.map((t) => t.title)).toEqual(["good"]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]!.fileName).toBe("broken.txt");
    expect(String((result.failures[0]!.error as Error).message)).toContain(
      "bad file",
    );
  });

  it("reports progress once per file, ending at parsedCount === totalCount", async () => {
    parseAudioFile.mockResolvedValue(track("a"));
    parseTextFile.mockRejectedValue(new Error("nope"));

    const progress: { parsedCount: number; totalCount: number }[] = [];
    await ingestFiles([file("a.mp3"), file("b.txt"), file("c.mp3")], {
      onProgress: (p) => progress.push({ ...p }),
    });

    // One progress event per file (failures still count toward progress).
    expect(progress).toHaveLength(3);
    for (const p of progress) expect(p.totalCount).toBe(3);
    // parsedCount is monotonic and lands exactly on the total.
    expect(progress.map((p) => p.parsedCount)).toEqual([1, 2, 3]);
  });
});
