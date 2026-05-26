import { describe, expect, it } from "vitest";
import {
  buildTracksFromExport,
  countResolved,
  tryParseCuratorExport,
} from "./curatorExportParser";

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
      spotifyUri: "spotify:track:abc",
      mbRecordingId: "mb-xyz",
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
    expect(env?.tracks[0].spotifyUri).toBe("spotify:track:abc");
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

  it("skips track entries that aren't plain objects", () => {
    const env = tryParseCuratorExport(
      JSON.stringify({
        format: "curator-playlist-v1",
        tracks: [null, 5, { title: "Only Valid" }],
      }),
    );
    expect(env?.tracks).toHaveLength(1);
    expect(env?.tracks[0].title).toBe("Only Valid");
  });
});

describe("buildTracksFromExport", () => {
  it("preserves spotify/mb resolution as matched status", () => {
    const env = tryParseCuratorExport(SAMPLE)!;
    const tracks = buildTracksFromExport(env);
    expect(tracks[0].spotify.status).toBe("matched");
    expect(tracks[0].spotify.uri).toBe("spotify:track:abc");
    expect(tracks[0].enrichment.status).toBe("matched");
    expect(tracks[0].enrichment.mbRecordingId).toBe("mb-xyz");
  });

  it("leaves unresolved tracks idle so runners pick them up", () => {
    const env = tryParseCuratorExport(SAMPLE)!;
    const tracks = buildTracksFromExport(env);
    expect(tracks[1].spotify.status).toBe("idle");
    expect(tracks[1].enrichment.status).toBe("idle");
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
