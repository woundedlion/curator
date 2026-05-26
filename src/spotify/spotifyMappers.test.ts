import { describe, expect, it } from "vitest";
import type {
  SpotifyPlaylistResponse,
  SpotifyTrackResponse,
} from "./dtos";
import {
  isImportableTrack,
  isMappablePlaylist,
  toImportedTrack,
  toPlaylistSummary,
  toSpotifyCandidate,
} from "./spotifyMappers";

function buildTrackResponse(
  overrides: Partial<SpotifyTrackResponse> = {},
): SpotifyTrackResponse {
  return {
    id: "track-1",
    uri: "spotify:track:track-1",
    name: "Karma Police",
    duration_ms: 261560,
    preview_url: null,
    artists: [{ id: "a1", name: "Radiohead" }],
    album: {
      id: "album-1",
      name: "OK Computer",
      release_date: "1997-06-16",
      images: [
        { url: "big.jpg", width: 640 },
        { url: "small.jpg", width: 64 },
        { url: "medium.jpg", width: 300 },
      ],
    },
    ...overrides,
  };
}

describe("toSpotifyCandidate", () => {
  it("copies core identity fields", () => {
    const c = toSpotifyCandidate(buildTrackResponse());
    expect(c).toMatchObject({
      uri: "spotify:track:track-1",
      id: "track-1",
      title: "Karma Police",
      artist: "Radiohead",
      album: "OK Computer",
      year: 1997,
      durationMs: 261560,
    });
  });

  it("joins multiple artists with comma", () => {
    const c = toSpotifyCandidate(
      buildTrackResponse({
        artists: [
          { id: "a", name: "Hall" },
          { id: "b", name: "Oates" },
        ],
      }),
    );
    expect(c.artist).toBe("Hall, Oates");
  });

  it("picks the smallest cover image", () => {
    const c = toSpotifyCandidate(buildTrackResponse());
    expect(c.coverUrl).toBe("small.jpg");
  });

  it("handles missing album images without throwing", () => {
    const c = toSpotifyCandidate(
      buildTrackResponse({
        album: { id: "a", name: "OK Computer", release_date: "1997" },
      }),
    );
    expect(c.coverUrl).toBeUndefined();
  });

  it("parses just-year release_date strings", () => {
    const c = toSpotifyCandidate(
      buildTrackResponse({
        album: { id: "a", name: "x", release_date: "2003" },
      }),
    );
    expect(c.year).toBe(2003);
  });

  it("returns undefined year on missing / unparseable release_date", () => {
    const c = toSpotifyCandidate(
      buildTrackResponse({
        album: { id: "a", name: "x", release_date: undefined },
      }),
    );
    expect(c.year).toBeUndefined();
  });

  it("converts a null preview_url into undefined", () => {
    const c = toSpotifyCandidate(buildTrackResponse({ preview_url: null }));
    expect(c.previewUrl).toBeUndefined();
  });

  it("starts with score 0 (scorer fills in later)", () => {
    const c = toSpotifyCandidate(buildTrackResponse());
    expect(c.score).toBe(0);
  });
});

describe("toPlaylistSummary", () => {
  const base: SpotifyPlaylistResponse = {
    id: "pl-1",
    name: "My Mix",
    owner: { id: "user-1", display_name: "Gabe" },
    images: [
      { url: "huge.jpg", width: 640 },
      { url: "tiny.jpg", width: 60 },
    ],
    items: { total: 17 },
  };

  it("maps the basics including the smallest image", () => {
    const out = toPlaylistSummary(base);
    expect(out).toMatchObject({
      id: "pl-1",
      name: "My Mix",
      trackCount: 17,
      ownerId: "user-1",
      ownerDisplayName: "Gabe",
      coverUrl: "tiny.jpg",
    });
  });

  it("falls back to tracks.total when items.total is absent", () => {
    const out = toPlaylistSummary({
      ...base,
      items: undefined,
      tracks: { total: 5 },
    });
    expect(out.trackCount).toBe(5);
  });

  it("returns undefined trackCount when neither envelope exists", () => {
    const out = toPlaylistSummary({
      ...base,
      items: undefined,
      tracks: undefined,
    });
    expect(out.trackCount).toBeUndefined();
  });

  it("substitutes a placeholder name when missing", () => {
    const out = toPlaylistSummary({
      ...base,
      name: undefined as unknown as string,
    });
    expect(out.name).toBe("(untitled)");
  });
});

describe("isMappablePlaylist", () => {
  it("requires id and name", () => {
    expect(isMappablePlaylist(null)).toBe(false);
    expect(isMappablePlaylist(undefined)).toBe(false);
    expect(
      isMappablePlaylist({
        id: "",
        name: "x",
        owner: { id: "u" },
      } as unknown as SpotifyPlaylistResponse),
    ).toBe(false);
    expect(
      isMappablePlaylist({
        id: "x",
        name: "",
        owner: { id: "u" },
      } as unknown as SpotifyPlaylistResponse),
    ).toBe(false);
    expect(
      isMappablePlaylist({
        id: "x",
        name: "y",
        owner: { id: "u" },
      } as unknown as SpotifyPlaylistResponse),
    ).toBe(true);
  });
});

describe("toImportedTrack", () => {
  it("builds a spotify-import sourced Track in matched state", () => {
    const t = toImportedTrack(buildTrackResponse());
    expect(t.source.kind).toBe("spotify-import");
    expect(t.source.spotifyUri).toBe("spotify:track:track-1");
    expect(t.spotify.status).toBe("matched");
    expect(t.spotify.uri).toBe("spotify:track:track-1");
    expect(t.enrichment.status).toBe("idle");
    expect(t.title).toBe("Karma Police");
    expect(t.artist).toBe("Radiohead");
    expect(t.album).toBe("OK Computer");
    expect(t.year).toBe(1997);
    expect(t.coverUrl).toBe("small.jpg");
  });

  it("generates a unique id per call", () => {
    const a = toImportedTrack(buildTrackResponse());
    const b = toImportedTrack(buildTrackResponse());
    expect(a.id).not.toBe(b.id);
  });
});

describe("isImportableTrack", () => {
  it("requires id, uri, and name", () => {
    expect(isImportableTrack(null)).toBe(false);
    expect(isImportableTrack(undefined)).toBe(false);
    expect(
      isImportableTrack({
        id: "x",
        uri: "spotify:track:x",
        name: "",
      } as unknown as SpotifyTrackResponse),
    ).toBe(false);
    expect(isImportableTrack(buildTrackResponse())).toBe(true);
  });
});
