import { describe, expect, it } from "vitest";
import { parseM3uContent } from "./m3uParser";

describe("parseM3uContent", () => {
  it("returns no tracks for empty / whitespace-only input", () => {
    expect(parseM3uContent("")).toEqual([]);
    expect(parseM3uContent("\n\n   \n")).toEqual([]);
  });

  it("ignores comment lines (other than EXTINF)", () => {
    const tracks = parseM3uContent("#EXTM3U\n#some random comment\nfoo.mp3\n");
    expect(tracks).toHaveLength(1);
    expect(tracks[0].source.rawLine).toBe("foo.mp3");
  });

  it("captures Artist - Title hints from EXTINF", () => {
    const m3u = [
      "#EXTM3U",
      "#EXTINF:259,Radiohead - Karma Police",
      "/music/track1.mp3",
    ].join("\n");
    const tracks = parseM3uContent(m3u);
    expect(tracks).toHaveLength(1);
    expect(tracks[0]).toMatchObject({
      artist: "Radiohead",
      title: "Karma Police",
    });
    expect(tracks[0].source.kind).toBe("m3u");
    expect(tracks[0].source.rawLine).toBe("/music/track1.mp3");
  });

  it("falls back to title-only when EXTINF has no separator", () => {
    const m3u = ["#EXTINF:120,Just A Title", "song.mp3"].join("\n");
    const tracks = parseM3uContent(m3u);
    expect(tracks[0]).toMatchObject({ title: "Just A Title", artist: undefined });
  });

  it("treats EXTINF with no content after the comma as no hint", () => {
    const m3u = ["#EXTINF:120,", "song.mp3"].join("\n");
    const tracks = parseM3uContent(m3u);
    expect(tracks[0].title).toBeUndefined();
    expect(tracks[0].artist).toBeUndefined();
  });

  it("treats EXTINF with whitespace-only content as no hint", () => {
    const m3u = ["#EXTINF:120,   ", "song.mp3"].join("\n");
    const tracks = parseM3uContent(m3u);
    expect(tracks[0].title).toBeUndefined();
    expect(tracks[0].artist).toBeUndefined();
  });

  it("treats EXTINF without a comma at all as no hint", () => {
    const m3u = ["#EXTINF:120", "song.mp3"].join("\n");
    const tracks = parseM3uContent(m3u);
    expect(tracks[0].title).toBeUndefined();
    expect(tracks[0].artist).toBeUndefined();
  });

  it("clears the EXTINF hint after one track consumes it", () => {
    const m3u = [
      "#EXTINF:1,Hinted Artist - Hinted Title",
      "first.mp3",
      "second.mp3",
    ].join("\n");
    const tracks = parseM3uContent(m3u);
    expect(tracks).toHaveLength(2);
    expect(tracks[0]).toMatchObject({ artist: "Hinted Artist", title: "Hinted Title" });
    // No carry-over hint into the second row.
    expect(tracks[1].artist).toBeUndefined();
    expect(tracks[1].title).toBeUndefined();
  });

  it("normalizes Windows / classic-Mac line endings", () => {
    const tracks = parseM3uContent("a.mp3\r\nb.mp3\rc.mp3");
    expect(tracks.map((t) => t.source.rawLine)).toEqual([
      "a.mp3",
      "b.mp3",
      "c.mp3",
    ]);
  });

  it("each track gets a unique id and idle status", () => {
    const tracks = parseM3uContent("a.mp3\nb.mp3");
    expect(tracks[0].id).not.toBe(tracks[1].id);
    expect(tracks[0].enrichment.status).toBe("idle");
    expect(tracks[0].spotify.status).toBe("idle");
  });
});
