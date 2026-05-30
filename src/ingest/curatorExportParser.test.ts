import { describe, expect, it, vi } from "vitest";
import {
  buildTracksFromExport,
  countResolved,
  tryParseCuratorExport,
} from "./curatorExportParser";

// Well-formed ids: a 22-char base62 Spotify track id and a canonical MBID.
const SAMPLE_URI = "spotify:track:6xZtSE6xGXNHqdz3DCDExJ";
const SAMPLE_MBID = "8d57c3a1-9b2e-4f0a-b1c2-d3e4f5a6b7c8";

const SAMPLE = JSON.stringify({
  format: "curator-playlist-v1",
  name: "My Mix",
  description: "demo",
  public: true,
  collaborative: false,
  tracks: [
    {
      title: "Karma Police",
      artist: "Radiohead",
      album: "OK Computer",
      year: 1997,
      spotifyUri: SAMPLE_URI,
      mbRecordingId: SAMPLE_MBID,
    },
    {
      title: "Plain Song",
    },
  ],
});

describe("tryParseCuratorExport", () => {
  it("parses a valid envelope", () => {
    const env = tryParseCuratorExport(SAMPLE);
    expect(env).not.toBeNull();
    expect(env?.name).toBe("My Mix");
    expect(env?.tracks).toHaveLength(2);
    expect(env?.tracks[0]!.spotifyUri).toBe(SAMPLE_URI);
  });

  it("drops malformed spotifyUri / mbRecordingId so the row isn't falsely matched", () => {
    // A hand-edited or hostile export must not be able to inject an
    // arbitrary string into spotify.uri (pushed to the Spotify API) by
    // claiming `matched`. Ill-formed ids are treated as absent.
    const env = tryParseCuratorExport(
      JSON.stringify({
        format: "curator-playlist-v1",
        tracks: [
          {
            title: "Bad Ids",
            spotifyUri: "spotify:track:abc",
            mbRecordingId: "mb-xyz",
          },
          {
            title: "Injection",
            spotifyUri: "javascript:alert(1)",
            mbRecordingId: "../../etc/passwd",
          },
        ],
      }),
    );
    expect(env?.tracks[0]!.spotifyUri).toBeUndefined();
    expect(env?.tracks[0]!.mbRecordingId).toBeUndefined();
    expect(env?.tracks[1]!.spotifyUri).toBeUndefined();
    expect(env?.tracks[1]!.mbRecordingId).toBeUndefined();
    const tracks = buildTracksFromExport(env!);
    expect(tracks[0]!.spotify.status).toBe("idle");
    expect(tracks[0]!.enrichment.status).toBe("idle");
  });

  it("returns null on non-JSON input", () => {
    expect(tryParseCuratorExport("Artist - Title")).toBeNull();
  });

  it("returns null when the format marker is missing", () => {
    const bad = JSON.stringify({ format: "other-thing", tracks: [] });
    expect(tryParseCuratorExport(bad)).toBeNull();
  });

  it("returns null on malformed JSON that happens to contain the marker", () => {
    // Defensive: a truncated file that contains the marker substring but
    // isn't valid JSON shouldn't crash the ingest pipeline.
    expect(
      tryParseCuratorExport('{ "format": "curator-playlist-v1" '),
    ).toBeNull();
  });

  it("cheaply rejects a large non-JSON .txt that merely mentions the marker", () => {
    // A plain text list whose body happens to contain the literal marker
    // string must NOT trigger a full JSON.parse of the whole file. It
    // doesn't start with `{`, so the pre-check rejects it without parsing.
    const big =
      "My favorite tracks (format: curator-playlist-v1 style)\n" +
      Array.from({ length: 5000 }, (_, i) => `Artist ${i} - Title ${i}`).join(
        "\n",
      );
    const spy = vi.spyOn(JSON, "parse");
    expect(tryParseCuratorExport(big)).toBeNull();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("rejects a JSON object whose marker only appears far past the scan window", () => {
    // Marker pushed beyond MARKER_SCAN_WINDOW by a giant leading field —
    // a real export always carries `format` near the top, so this is
    // treated as a non-export (and never fully parsed for detection).
    const filler = "x".repeat(2000);
    const text = `{ "note": "${filler}", "format": "curator-playlist-v1", "tracks": [] }`;
    expect(tryParseCuratorExport(text)).toBeNull();
  });

  it("skips track entries that aren't plain objects", () => {
    const env = tryParseCuratorExport(
      JSON.stringify({
        format: "curator-playlist-v1",
        tracks: [null, 5, { title: "Only Valid" }],
      }),
    );
    expect(env?.tracks).toHaveLength(1);
    expect(env?.tracks[0]!.title).toBe("Only Valid");
  });
});

describe("buildTracksFromExport", () => {
  it("preserves spotify/mb resolution as matched status", () => {
    const env = tryParseCuratorExport(SAMPLE)!;
    const tracks = buildTracksFromExport(env);
    const spotify = tracks[0]!.spotify;
    const enrichment = tracks[0]!.enrichment;
    expect(spotify.status).toBe("matched");
    if (spotify.status === "matched") expect(spotify.uri).toBe(SAMPLE_URI);
    expect(enrichment.status).toBe("matched");
    if (enrichment.status === "matched")
      expect(enrichment.mbRecordingId).toBe(SAMPLE_MBID);
  });

  it("leaves unresolved tracks idle so runners pick them up", () => {
    const env = tryParseCuratorExport(SAMPLE)!;
    const tracks = buildTracksFromExport(env);
    expect(tracks[1]!.spotify.status).toBe("idle");
    expect(tracks[1]!.enrichment.status).toBe("idle");
  });

  it("reconstructs a faithful 'Artist - Title' rawLine when both are present", () => {
    const env = tryParseCuratorExport(SAMPLE)!;
    const tracks = buildTracksFromExport(env);
    expect(tracks[0]!.source).toEqual({
      kind: "text",
      rawLine: "Radiohead - Karma Police",
    });
    // Title-only row falls back to the bare title.
    expect(tracks[1]!.source).toEqual({ kind: "text", rawLine: "Plain Song" });
  });
});

describe("countResolved", () => {
  it("counts spotify and mb-matched tracks independently", () => {
    const env = tryParseCuratorExport(SAMPLE)!;
    expect(countResolved(env)).toEqual({
      total: 2,
      spotifyMatched: 1,
      mbMatched: 1,
    });
  });
});
