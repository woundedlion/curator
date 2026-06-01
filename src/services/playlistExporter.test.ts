// @vitest-environment happy-dom
//
// Tests for the curator-export builder + download trigger. This is the
// round-trip counterpart to the already-tested curatorExportParser, so we
// also assert that a built envelope has the exact shape the parser expects.
//
// Coverage:
//   - buildExportEnvelope field mapping: which Track fields are carried
//     vs intentionally dropped (localFile + full candidate arrays), the
//     `format` marker, and undefined-track filtering.
//   - slugify edge cases (empty → "playlist", non-ASCII/CJK collapse,
//     spaces/punctuation) via the download filename.
//   - exportActivePlaylist download trigger: createObjectURL + anchor
//     click + the DEFERRED revokeObjectURL (setTimeout 0) path, and the
//     empty-playlist early return.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getPlaylistState: vi.fn(),
  pushToast: vi.fn(),
}));

vi.mock("../store/playlistStore", () => ({
  usePlaylistStore: { getState: () => mocks.getPlaylistState() },
}));
vi.mock("../store/uiStore", () => ({
  useUiStore: { getState: () => ({ pushToast: mocks.pushToast }) },
}));

import {
  buildExportEnvelope,
  exportActivePlaylist,
} from "./playlistExporter";
import { CURATOR_EXPORT_FORMAT } from "../ingest/curatorExportFormat";
import { tryParseCuratorExport } from "../ingest/curatorExportParser";
import type { Track } from "../types";

function fullTrack(): Track {
  return {
    id: "t1",
    source: { kind: "file", fileName: "song.mp3" },
    title: "Title",
    artist: "Artist",
    album: "Album",
    albumArtist: "Album Artist",
    year: 2001,
    originalYear: 1999,
    trackNo: 4,
    trackOf: 12,
    discNo: 1,
    durationMs: 210_000,
    coverUrl: "https://example.test/cover.jpg",
    // Intentionally-dropped fields:
    localFile: { name: "song.mp3" } as unknown as File,
    spotify: {
      status: "matched",
      uri: "spotify:track:aaaaaaaaaaaaaaaaaaaaaa",
      candidates: [
        {
          uri: "spotify:track:aaaaaaaaaaaaaaaaaaaaaa",
          id: "aaaaaaaaaaaaaaaaaaaaaa",
          title: "Title",
          artist: "Artist",
          score: 1,
        },
      ],
      score: 1,
    },
    enrichment: {
      status: "matched",
      mbRecordingId: "11111111-2222-3333-4444-555555555555",
      score: 1,
      candidates: [
        {
          recordingId: "11111111-2222-3333-4444-555555555555",
          title: "Title",
          artist: "Artist",
          score: 1,
        },
      ],
    },
  };
}

function stateWith(
  tracksById: Record<string, Track | undefined>,
  trackIds: string[],
  playlistOverrides: Partial<{
    name: string;
    description?: string;
    public: boolean;
    collaborative: boolean;
  }> = {},
): { playlist: Record<string, unknown>; tracksById: typeof tracksById } {
  return {
    tracksById,
    playlist: {
      id: "pl",
      name: "My Playlist",
      description: "A mix",
      public: true,
      collaborative: false,
      trackIds,
      sort: null,
      hideUnmatched: false,
      ...playlistOverrides,
    },
  };
}

beforeEach(() => {
  mocks.getPlaylistState.mockReset();
  mocks.pushToast.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("buildExportEnvelope — field mapping", () => {
  it("carries the round-trippable fields and the resolved spotify/mb ids", () => {
    const t = fullTrack();
    mocks.getPlaylistState.mockReturnValue(stateWith({ t1: t }, ["t1"]));

    const env = buildExportEnvelope();

    expect(env.format).toBe(CURATOR_EXPORT_FORMAT);
    expect(env.name).toBe("My Playlist");
    expect(env.description).toBe("A mix");
    expect(env.public).toBe(true);
    expect(env.collaborative).toBe(false);
    expect(env.tracks).toHaveLength(1);

    const out = env.tracks[0]!;
    expect(out).toEqual({
      title: "Title",
      artist: "Artist",
      album: "Album",
      albumArtist: "Album Artist",
      year: 2001,
      originalYear: 1999,
      trackNo: 4,
      trackOf: 12,
      discNo: 1,
      durationMs: 210_000,
      coverUrl: "https://example.test/cover.jpg",
      spotifyUri: "spotify:track:aaaaaaaaaaaaaaaaaaaaaa",
      mbRecordingId: "11111111-2222-3333-4444-555555555555",
    });
  });

  it("drops localFile and the full candidate arrays (not round-trippable)", () => {
    const t = fullTrack();
    mocks.getPlaylistState.mockReturnValue(stateWith({ t1: t }, ["t1"]));

    const out = buildExportEnvelope().tracks[0]! as Record<string, unknown>;

    expect(out).not.toHaveProperty("localFile");
    expect(out).not.toHaveProperty("candidates");
    expect(out).not.toHaveProperty("id");
    expect(out).not.toHaveProperty("source");
    expect(out).not.toHaveProperty("status");
  });

  it("omits spotifyUri / mbRecordingId for unresolved rows", () => {
    const t: Track = {
      id: "t1",
      source: { kind: "text" },
      title: "Lonely",
      artist: "Nobody",
      spotify: { status: "idle" },
      enrichment: { status: "idle" },
    };
    mocks.getPlaylistState.mockReturnValue(stateWith({ t1: t }, ["t1"]));

    const out = buildExportEnvelope().tracks[0]!;
    expect(out.spotifyUri).toBeUndefined();
    expect(out.mbRecordingId).toBeUndefined();
  });

  it("filters out undefined tracks (id present in trackIds but missing from map)", () => {
    const t = fullTrack();
    mocks.getPlaylistState.mockReturnValue(
      stateWith({ t1: t, ghost: undefined }, ["t1", "ghost", "missing-id"]),
    );

    const env = buildExportEnvelope();
    expect(env.tracks).toHaveLength(1);
    expect(env.tracks[0]!.title).toBe("Title");
  });

  it("defaults a missing description to empty string", () => {
    const t = fullTrack();
    mocks.getPlaylistState.mockReturnValue(
      stateWith({ t1: t }, ["t1"], { description: undefined }),
    );
    expect(buildExportEnvelope().description).toBe("");
  });

  it("round-trips through the parser to an equivalent envelope (parser-compatible shape)", () => {
    const t = fullTrack();
    mocks.getPlaylistState.mockReturnValue(stateWith({ t1: t }, ["t1"]));

    const env = buildExportEnvelope();
    const json = JSON.stringify(env, null, 2);
    const reparsed = tryParseCuratorExport(json);

    expect(reparsed).not.toBeNull();
    expect(reparsed!.format).toBe(CURATOR_EXPORT_FORMAT);
    expect(reparsed!.name).toBe(env.name);
    expect(reparsed!.tracks).toEqual(env.tracks);
  });
});

describe("slugify (observed via the download filename)", () => {
  // slugify is internal; we drive it through exportActivePlaylist and read
  // the anchor's `download` attribute.
  function downloadNameForPlaylistName(name: string): string {
    const t = fullTrack();
    mocks.getPlaylistState.mockReturnValue(
      stateWith({ t1: t }, ["t1"], { name }),
    );

    let captured = "";
    const realCreate = document.createElement.bind(document);
    const spy = vi
      .spyOn(document, "createElement")
      .mockImplementation((tag: string) => {
        const el = realCreate(tag) as HTMLElement;
        if (tag === "a") {
          // Capture the download attribute at click time, and suppress
          // the real navigation (happy-dom's anchor click would attempt
          // a page navigation).
          const anchor = el as HTMLAnchorElement;
          anchor.click = () => {
            captured = anchor.download;
          };
        }
        return el;
      });

    const createSpy = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValue("blob:mock");
    const revokeSpy = vi
      .spyOn(URL, "revokeObjectURL")
      .mockImplementation(() => undefined);

    exportActivePlaylist();
    spy.mockRestore();
    createSpy.mockRestore();
    revokeSpy.mockRestore();
    return captured;
  }

  it.each([
    ["empty name → 'playlist' fallback", "", "playlist.curator.txt"],
    [
      "whitespace/punctuation-only → 'playlist' fallback",
      "   !!! ???  ",
      "playlist.curator.txt",
    ],
    [
      "spaces collapse to single hyphens + lowercased",
      "My Cool   Mix",
      "my-cool-mix.curator.txt",
    ],
    [
      "punctuation stripped, hyphens kept",
      "Rock & Roll: Greatest-Hits!",
      "rock-roll-greatest-hits.curator.txt",
    ],
    [
      "non-ASCII/CJK collapse to the fallback when nothing remains",
      "日本語",
      "playlist.curator.txt",
    ],
    [
      "accented latin decomposes to ascii base letters",
      "Café Déjà",
      "cafe-deja.curator.txt",
    ],
  ])("%s", (_label, name, expected) => {
    expect(downloadNameForPlaylistName(name)).toBe(expected);
  });
});

describe("exportActivePlaylist — download trigger", () => {
  it("no-ops on an empty playlist (no URL/createObjectURL, no toast)", () => {
    mocks.getPlaylistState.mockReturnValue(stateWith({}, []));
    const createObjectURL = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValue("blob:mock");

    exportActivePlaylist();

    expect(createObjectURL).not.toHaveBeenCalled();
    expect(mocks.pushToast).not.toHaveBeenCalled();
    createObjectURL.mockRestore();
  });

  it("creates an object URL, clicks an anchor, defers revoke to a macrotask, and toasts", () => {
    vi.useFakeTimers();
    try {
      const t = fullTrack();
      mocks.getPlaylistState.mockReturnValue(stateWith({ t1: t }, ["t1"]));

      const createObjectURL = vi
        .spyOn(URL, "createObjectURL")
        .mockReturnValue("blob:mock-url");
      const revokeObjectURL = vi
        .spyOn(URL, "revokeObjectURL")
        .mockImplementation(() => undefined);
      // Suppress happy-dom's real anchor navigation on click.
      const clickSpy = vi
        .spyOn(HTMLAnchorElement.prototype, "click")
        .mockImplementation(() => undefined);

      const appendSpy = vi.spyOn(document.body, "appendChild");

      exportActivePlaylist();

      expect(createObjectURL).toHaveBeenCalledTimes(1);
      // The blob is wired onto an anchor that was appended to the body.
      expect(appendSpy).toHaveBeenCalled();
      // Revoke is DEFERRED — not called synchronously.
      expect(revokeObjectURL).not.toHaveBeenCalled();

      // The macrotask (setTimeout 0) runs the deferred revoke.
      vi.runAllTimers();
      expect(revokeObjectURL).toHaveBeenCalledWith("blob:mock-url");

      // Success toast reports the track count.
      expect(mocks.pushToast).toHaveBeenCalledWith({
        kind: "success",
        message: "Exported 1 tracks",
      });

      createObjectURL.mockRestore();
      revokeObjectURL.mockRestore();
      clickSpy.mockRestore();
      appendSpy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });
});
