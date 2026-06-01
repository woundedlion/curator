// Tests for the publish/read paths in spotify/playlists.ts. We mock the
// apiClient's `callSpotify` so paged responses and per-chunk failures can
// be simulated deterministically, while keeping the real typed error
// classes (SpotifyAuthExpiredError / SpotifyRateLimitError /
// SpotifyServerError) via importActual so `isFatalPushError`'s
// instanceof checks behave as in production.
//
// Coverage:
//   - fetchAllPages: `/v1` prefix stripping on `next`, the page-count
//     cap, and normal multi-page accumulation.
//   - pushTracksToPlaylist: chunking + failedChunks bucketing on a
//     partial (non-fatal) failure.
//   - isFatalPushError classification (via pushTracksToPlaylist): an
//     auth-expired / rate-limit / token-endpoint 5xx aborts the whole
//     push, while a chunk-level 5xx on /items stays retryable/bucketed.
//   - EmptyReplaceUrisError guard on the destructive PUT.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// localStorage polyfill — apiClient.ts reads from it at module init even
// though we mock callSpotify (the module still evaluates).
class MemoryStorage implements Storage {
  private store = new Map<string, string>();
  get length(): number {
    return this.store.size;
  }
  clear(): void {
    this.store.clear();
  }
  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }
  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null;
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
}
vi.stubGlobal("localStorage", new MemoryStorage());

const mocks = vi.hoisted(() => ({
  callSpotify: vi.fn(),
}));

vi.mock("./apiClient", async () => {
  const actual = await vi.importActual<typeof ApiClientModule>("./apiClient");
  return {
    ...actual,
    callSpotify: mocks.callSpotify,
    submitSpotifyRequest: mocks.callSpotify,
  };
});

import type * as ApiClientModule from "./apiClient";
import {
  SpotifyAuthExpiredError,
  SpotifyRateLimitError,
  SpotifyServerError,
} from "./apiClient";
import {
  EmptyReplaceUrisError,
  fetchAllPlaylists,
  pushTracksToPlaylist,
  replaceAndPushTracks,
} from "./playlists";
import { SPOTIFY_TRACK_ADD_CHUNK } from "../constants";

const CLIENT = "test-client";
const CLIENT_PLAYLIST = "playlist-1";

type Call = { path: string; method?: string; body?: unknown; query?: unknown };

function lastCalls(): Call[] {
  return mocks.callSpotify.mock.calls.map((c) => c[0] as Call);
}

beforeEach(() => {
  mocks.callSpotify.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("fetchAllPages (via fetchAllPlaylists)", () => {
  it("accumulates items across multiple pages", async () => {
    const mappable = (id: string) => ({
      id,
      name: `P ${id}`,
      owner: { id: "owner" },
      tracks: { total: 3 },
    });
    mocks.callSpotify
      .mockResolvedValueOnce({
        items: [mappable("a"), mappable("b")],
        next: "https://api.spotify.com/v1/me/playlists?offset=2&limit=50",
        total: 3,
      })
      .mockResolvedValueOnce({
        items: [mappable("c")],
        next: null,
        total: 3,
      });

    const result = await fetchAllPlaylists(CLIENT);

    expect(result.map((p) => p.id)).toEqual(["a", "b", "c"]);
    expect(mocks.callSpotify).toHaveBeenCalledTimes(2);
  });

  it("strips the `/v1` prefix from the absolute `next` URL", async () => {
    mocks.callSpotify
      .mockResolvedValueOnce({
        items: [],
        next: "https://api.spotify.com/v1/me/playlists?offset=50&limit=50",
        total: 0,
      })
      .mockResolvedValueOnce({ items: [], next: null, total: 0 });

    await fetchAllPlaylists(CLIENT);

    // First call uses the initial path + the limit query.
    expect(lastCalls()[0]!.path).toBe("/me/playlists");
    // Second call follows `next` with the `/v1` prefix stripped (so
    // callSpotify, which prepends a base that already has /v1, doesn't
    // double it) and the query carried in the URL search string.
    expect(lastCalls()[1]!.path).toBe("/me/playlists?offset=50&limit=50");
    // The follow-on page must NOT re-pass the initial query object.
    expect(lastCalls()[1]!.query).toBeUndefined();
  });

  it("passes an unversioned `next` path through unchanged", async () => {
    mocks.callSpotify
      .mockResolvedValueOnce({
        items: [],
        // No `/v1/` prefix — tolerate by passing through unchanged.
        next: "https://api.spotify.com/me/playlists?offset=50",
        total: 0,
      })
      .mockResolvedValueOnce({ items: [], next: null, total: 0 });

    await fetchAllPlaylists(CLIENT);

    expect(lastCalls()[1]!.path).toBe("/me/playlists?offset=50");
  });

  it("throws once the page-count cap (500) is exceeded — a malformed `next` loop", async () => {
    // Always return a `next` so the loop never terminates naturally; the
    // FETCH_ALL_PAGES_MAX cap must break it with a loud error.
    mocks.callSpotify.mockResolvedValue({
      items: [],
      next: "https://api.spotify.com/v1/me/playlists?offset=1&limit=50",
      total: 0,
    });

    await expect(fetchAllPlaylists(CLIENT)).rejects.toThrow(
      /exceeded 500 pages/,
    );
    // Exactly the cap's worth of requests went out before the throw.
    expect(mocks.callSpotify).toHaveBeenCalledTimes(500);
  });
});

describe("pushTracksToPlaylist — chunking + failedChunks bucketing", () => {
  function uris(n: number): string[] {
    return Array.from({ length: n }, (_, i) => `spotify:track:${i}`);
  }

  it("chunks by SPOTIFY_TRACK_ADD_CHUNK and reports total added", async () => {
    mocks.callSpotify.mockResolvedValue(undefined);
    const n = SPOTIFY_TRACK_ADD_CHUNK * 2 + 3;

    const progress = await pushTracksToPlaylist(CLIENT_PLAYLIST, uris(n), CLIENT);

    expect(mocks.callSpotify).toHaveBeenCalledTimes(3);
    expect(progress.added).toBe(n);
    expect(progress.total).toBe(n);
    expect(progress.failedChunks).toEqual([]);
  });

  it("buckets a chunk-level 5xx on /items as a failed chunk and continues", async () => {
    const n = SPOTIFY_TRACK_ADD_CHUNK * 3;
    // Second chunk (index 1) fails with a non-fatal server error on the
    // /items path; the push continues and the other chunks still add.
    mocks.callSpotify
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(
        new SpotifyServerError("/playlists/p/items", 503, "down"),
      )
      .mockResolvedValueOnce(undefined);

    const progress = await pushTracksToPlaylist(CLIENT_PLAYLIST, uris(n), CLIENT);

    expect(progress.failedChunks).toEqual([1]);
    // Two of three chunks succeeded.
    expect(progress.added).toBe(SPOTIFY_TRACK_ADD_CHUNK * 2);
    expect(mocks.callSpotify).toHaveBeenCalledTimes(3);
  });

  it("reports incremental progress per chunk via onProgress", async () => {
    mocks.callSpotify.mockResolvedValue(undefined);
    const n = SPOTIFY_TRACK_ADD_CHUNK * 2;
    const snapshots: number[] = [];

    await pushTracksToPlaylist(CLIENT_PLAYLIST, uris(n), CLIENT, {
      onProgress: (p) => snapshots.push(p.added),
    });

    expect(snapshots).toEqual([
      SPOTIFY_TRACK_ADD_CHUNK,
      SPOTIFY_TRACK_ADD_CHUNK * 2,
    ]);
  });

  it.each([
    ["auth-expired", new SpotifyAuthExpiredError()],
    ["rate-limit", new SpotifyRateLimitError(1000)],
    ["token-endpoint 5xx", new SpotifyServerError("/api/token", 503, "down")],
  ])("aborts the whole push on a fatal error: %s", async (_label, error) => {
    const n = SPOTIFY_TRACK_ADD_CHUNK * 3;
    // First chunk succeeds, second throws the fatal error — the push must
    // re-throw it and NOT attempt the third chunk.
    mocks.callSpotify
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(error);

    await expect(
      pushTracksToPlaylist(CLIENT_PLAYLIST, uris(n), CLIENT),
    ).rejects.toBe(error);
    // The third chunk never ran — the push aborted at the fatal chunk.
    expect(mocks.callSpotify).toHaveBeenCalledTimes(2);
  });
});

describe("replaceAndPushTracks — EmptyReplaceUrisError guard", () => {
  it("throws EmptyReplaceUrisError on empty uris WITHOUT issuing any request", async () => {
    await expect(
      replaceAndPushTracks(CLIENT_PLAYLIST, [], CLIENT),
    ).rejects.toBeInstanceOf(EmptyReplaceUrisError);
    // Crucially: the destructive PUT never went out.
    expect(mocks.callSpotify).not.toHaveBeenCalled();
  });

  it("issues a PUT for the first chunk then POSTs the rest", async () => {
    mocks.callSpotify.mockResolvedValue(undefined);
    const n = SPOTIFY_TRACK_ADD_CHUNK + 2;
    const uris = Array.from({ length: n }, (_, i) => `spotify:track:${i}`);

    const progress = await replaceAndPushTracks(CLIENT_PLAYLIST, uris, CLIENT);

    const calls = lastCalls();
    expect(calls[0]!.method).toBe("PUT");
    expect(calls[1]!.method).toBe("POST");
    expect(progress.added).toBe(n);
    expect(progress.failedChunks).toEqual([]);
  });
});
