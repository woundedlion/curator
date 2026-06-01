import { describe, expect, it } from "vitest";
import { parseM3uContent } from "./m3uParser";
import type { TrackSource } from "../types";

// m3u rows carry their URL in the `rawLine` arm of the TrackSource union.
function rawLineOf(source: TrackSource): string | undefined {
  return "rawLine" in source ? source.rawLine : undefined;
}

describe("parseM3uContent", () => {
  it("returns no tracks for empty / whitespace-only input", () => {
    expect(parseM3uContent("")).toEqual([]);
    expect(parseM3uContent("\n\n   \n")).toEqual([]);
  });

  it("ignores comment lines (other than EXTINF)", () => {
    const tracks = parseM3uContent("#EXTM3U\n#some random comment\nfoo.mp3\n");
    expect(tracks).toHaveLength(1);
    expect(rawLineOf(tracks[0]!.source)).toBe("foo.mp3");
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
    expect(tracks[0]!.source.kind).toBe("m3u");
    expect(rawLineOf(tracks[0]!.source)).toBe("/music/track1.mp3");
  });

  it("extracts album from a 3-part EXTINF tail (artist - album - title)", () => {
    // Previously the tail was split only on the first separator, so
    // everything after the artist became the title and the album was
    // silently lost. Routing through classifySegments restores it.
    const m3u = [
      "#EXTINF:200,Radiohead - OK Computer - Karma Police",
      "/music/track.mp3",
    ].join("\n");
    const tracks = parseM3uContent(m3u);
    expect(tracks[0]).toMatchObject({
      artist: "Radiohead",
      album: "OK Computer",
      title: "Karma Police",
    });
  });

  it("extracts the track number from a 4-part EXTINF tail", () => {
    const m3u = [
      "#EXTINF:200,Radiohead - In Rainbows - 03 - Nude",
      "/music/track.mp3",
    ].join("\n");
    const tracks = parseM3uContent(m3u);
    expect(tracks[0]).toMatchObject({
      artist: "Radiohead",
      album: "In Rainbows",
      trackNo: 3,
      title: "Nude",
    });
  });

  it("falls back to title-only when EXTINF has no separator", () => {
    const m3u = ["#EXTINF:120,Just A Title", "song.mp3"].join("\n");
    const tracks = parseM3uContent(m3u);
    expect(tracks[0]).toMatchObject({ title: "Just A Title", artist: undefined });
  });

  it("derives metadata from the path basename when EXTINF gives no hint (empty tail)", () => {
    // EXTINF contributed nothing, so the row falls back to the path
    // basename: a bare filename yields a title (no " - " ⇒ no artist).
    const m3u = ["#EXTINF:120,", "song.mp3"].join("\n");
    const tracks = parseM3uContent(m3u);
    expect(tracks[0]!.title).toBe("song");
    expect(tracks[0]!.artist).toBeUndefined();
  });

  it("derives from the basename when EXTINF tail is whitespace-only", () => {
    const m3u = ["#EXTINF:120,   ", "song.mp3"].join("\n");
    const tracks = parseM3uContent(m3u);
    expect(tracks[0]!.title).toBe("song");
    expect(tracks[0]!.artist).toBeUndefined();
  });


  it("derives from the basename when EXTINF has no comma at all", () => {
    const m3u = ["#EXTINF:120", "song.mp3"].join("\n");
    const tracks = parseM3uContent(m3u);
    expect(tracks[0]!.title).toBe("song");
    expect(tracks[0]!.artist).toBeUndefined();
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
    // No carry-over EXTINF hint; the second row derives from its basename.
    expect(tracks[1]!.artist).toBeUndefined();
    expect(tracks[1]!.title).toBe("second");
  });

  it("derives artist/title from a path-only line (no EXTINF)", () => {
    const tracks = parseM3uContent("/music/Radiohead - Karma Police.mp3");
    expect(tracks[0]).toMatchObject({
      artist: "Radiohead",
      title: "Karma Police",
    });
  });

  it("uses the basename of a URL line, stripping query/fragment and percent-encoding", () => {
    const tracks = parseM3uContent(
      "https://cdn.example.com/a/b/Daft%20Punk%20-%20One%20More%20Time.mp3?token=xyz#t=0",
    );
    expect(tracks[0]).toMatchObject({
      artist: "Daft Punk",
      title: "One More Time",
    });
  });

  it("lets EXTINF metadata win over the path basename, filling only gaps", () => {
    const m3u = [
      "#EXTINF:200,Real Artist - Real Title",
      "/music/Wrong - Name.mp3",
    ].join("\n");
    const tracks = parseM3uContent(m3u);
    expect(tracks[0]).toMatchObject({
      artist: "Real Artist",
      title: "Real Title",
    });
  });

  it("normalizes Windows / classic-Mac line endings", () => {
    const tracks = parseM3uContent("a.mp3\r\nb.mp3\rc.mp3");
    expect(tracks.map((t) => rawLineOf(t.source))).toEqual([
      "a.mp3",
      "b.mp3",
      "c.mp3",
    ]);
  });

  it("extracts the EXTINF duration (seconds) into durationMs", () => {
    const tracks = parseM3uContent("#EXTINF:259,Radiohead - Karma Police\nx.mp3");
    expect(tracks[0]!.durationMs).toBe(259_000);
  });

  it("accepts floating-point EXTINF seconds (foobar2000 writes these)", () => {
    const tracks = parseM3uContent("#EXTINF:259.5,A - B\nx.mp3");
    expect(tracks[0]!.durationMs).toBe(259_500);
  });

  it("treats `-1` (unknown duration per EXTM3U convention) as missing", () => {
    const tracks = parseM3uContent("#EXTINF:-1,A - B\nx.mp3");
    expect(tracks[0]!.durationMs).toBeUndefined();
  });

  it("treats a non-numeric duration field as missing", () => {
    const tracks = parseM3uContent("#EXTINF:not-a-number,A - B\nx.mp3");
    expect(tracks[0]!.durationMs).toBeUndefined();
    // Other hints still flow through.
    expect(tracks[0]!.artist).toBe("A");
    expect(tracks[0]!.title).toBe("B");
  });

  it("retains durationMs and derives the title from the basename when the tail is empty", () => {
    const tracks = parseM3uContent("#EXTINF:200,\nx.mp3");
    expect(tracks[0]!.durationMs).toBe(200_000);
    expect(tracks[0]!.title).toBe("x");
    expect(tracks[0]!.artist).toBeUndefined();
  });

  it("each track gets a unique id and idle status", () => {
    const tracks = parseM3uContent("a.mp3\nb.mp3");
    expect(tracks[0]!.id).not.toBe(tracks[1]!.id);
    expect(tracks[0]!.enrichment.status).toBe("idle");
    expect(tracks[0]!.spotify.status).toBe("idle");
  });
});
