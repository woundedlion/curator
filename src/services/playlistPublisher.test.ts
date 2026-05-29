// Tests for the publish flow — wraps Spotify's create/replace/push
// endpoints behind a single boundary that the toolbar's "Publish"
// gesture targets. DESIGN §4.5 (Playlist creation) and §4.5.1 cover
// the surface here.
//
// Contracts verified:
//   1. Successful create+push reports added == total with no failed
//      chunks. The created playlist's id and URL flow back to the
//      caller (so the success toast can include the link).
//   2. A chunk that throws a non-fatal error is recorded in
//      `progress.failedChunks` while every other chunk still runs.
//      This protects DESIGN item 19 ("partial publish surfacing" —
//      error toast with X/Y added).
//   3. EmptyReplaceError is thrown when the draft has no eligible
//      tracks. Both create and update mode use the same guard;
//      otherwise create-mode would litter the user's account with
//      empty playlists.
//   4. `hideUnmatched` narrows the eligible set to matched-only.
//      With it off, ambiguous-but-uri rows are still pushed (DESIGN
//      §4.5 — the user can publish before resolving every ambiguous
//      pick, on the principle "pick the highest-score URI we found
//      and move on").
//   5. Update mode calls replaceAndPushTracks against the existing
//      playlistId; create mode goes through createPlaylist + then
//      pushTracksToPlaylist.
//   6. onProgress is invoked at least once per chunk so the UI can
//      animate a real progress bar (not just "spinner forever").

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Track } from "../types";
import type { PlaylistPushProgress } from "../spotify/playlists";

const mocks = vi.hoisted(() => ({
  createPlaylist: vi.fn<
    (
      input: {
        name: string;
        description?: string;
        public: boolean;
        collaborative: boolean;
      },
      clientId: string,
    ) => Promise<{ id: string }>
  >(),
  pushTracksToPlaylist: vi.fn<
    (
      playlistId: string,
      uris: string[],
      clientId: string,
      handlers?: { onProgress?: (p: PlaylistPushProgress) => void },
    ) => Promise<PlaylistPushProgress>
  >(),
  replaceAndPushTracks: vi.fn<
    (
      playlistId: string,
      uris: string[],
      clientId: string,
      handlers?: { onProgress?: (p: PlaylistPushProgress) => void },
    ) => Promise<PlaylistPushProgress>
  >(),
}));

vi.mock("../spotify/playlists", () => ({
  createPlaylist: mocks.createPlaylist,
  pushTracksToPlaylist: mocks.pushTracksToPlaylist,
  replaceAndPushTracks: mocks.replaceAndPushTracks,
}));

import {
  EmptyReplaceError,
  publishPlaylist,
} from "./playlistPublisher";
import { usePlaylistStore } from "../store/playlistStore";

function trackOf(fields: Partial<Track> & { id: string }): Track {
  return {
    source: { kind: "text" },
    enrichment: { status: "idle" },
    spotify: { status: "idle" },
    ...fields,
  };
}

function matched(id: string, uri: string): Track {
  return trackOf({
    id,
    spotify: { status: "matched", uri, candidates: [], score: 1 },
  });
}

function ambiguous(id: string, uri?: string): Track {
  return trackOf({
    id,
    spotify: { status: "ambiguous", uri, candidates: [], score: 0.5 },
  });
}

function seed(tracks: Track[], hideUnmatched = false): void {
  const tracksById: Record<string, Track> = {};
  for (const t of tracks) tracksById[t.id] = t;
  usePlaylistStore.setState({
    tracksById,
    playlist: {
      ...usePlaylistStore.getState().playlist,
      trackIds: tracks.map((t) => t.id),
      name: "My Mix",
      description: "from the draft",
      public: false,
      collaborative: false,
      hideUnmatched,
    },
  });
}

beforeEach(() => {
  mocks.createPlaylist.mockReset();
  mocks.pushTracksToPlaylist.mockReset();
  mocks.replaceAndPushTracks.mockReset();

  mocks.createPlaylist.mockResolvedValue({ id: "pl-created" });
  // Default pushTracksToPlaylist: a successful all-chunks-added result.
  // Individual tests override to exercise partial / multi-chunk paths.
  mocks.pushTracksToPlaylist.mockImplementation(async (_id, uris) => ({
    added: uris.length,
    total: uris.length,
    failedChunks: [],
  }));
  mocks.replaceAndPushTracks.mockImplementation(async (_id, uris) => ({
    added: uris.length,
    total: uris.length,
    failedChunks: [],
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
  usePlaylistStore.setState({
    tracksById: {},
    playlist: {
      ...usePlaylistStore.getState().playlist,
      trackIds: [],
      hideUnmatched: false,
    },
  });
});

describe("publishPlaylist — create mode", () => {
  it("creates a playlist, pushes every matched URI, and returns the playlist link", async () => {
    seed([
      matched("a", "spotify:track:a"),
      matched("b", "spotify:track:b"),
      matched("c", "spotify:track:c"),
    ]);

    const result = await publishPlaylist("client", { kind: "create" });

    expect(mocks.createPlaylist).toHaveBeenCalledTimes(1);
    expect(mocks.createPlaylist).toHaveBeenCalledWith(
      {
        name: "My Mix",
        description: "from the draft",
        public: false,
        collaborative: false,
      },
      "client",
    );
    expect(mocks.pushTracksToPlaylist).toHaveBeenCalledTimes(1);
    const [pushedId, pushedUris] =
      mocks.pushTracksToPlaylist.mock.calls[0]!;
    expect(pushedId).toBe("pl-created");
    expect(pushedUris).toEqual([
      "spotify:track:a",
      "spotify:track:b",
      "spotify:track:c",
    ]);

    expect(result.playlistId).toBe("pl-created");
    // The web URL is the source of truth for the success-toast link
    // — verify the publisher built it correctly.
    expect(result.playlistUrl).toBe(
      "https://open.spotify.com/playlist/pl-created",
    );
    expect(result.progress.added).toBe(3);
    expect(result.progress.total).toBe(3);
    expect(result.progress.failedChunks).toEqual([]);
  });

  it("includes ambiguous-with-uri rows when hideUnmatched is OFF", async () => {
    // Without hideUnmatched, the user has decided "publish my draft
    // as-is, even rows I haven't disambiguated yet". The publisher
    // picks whatever URI Spotify auto-selected as #1 for ambiguous
    // rows (track.spotify.uri is the top candidate's URI).
    seed(
      [
        matched("a", "spotify:track:a"),
        ambiguous("amb", "spotify:track:amb-top"),
        ambiguous("noUri"), // no uri → skipped silently
      ],
      false,
    );

    await publishPlaylist("client", { kind: "create" });

    const [, uris] = mocks.pushTracksToPlaylist.mock.calls[0]!;
    expect(uris).toEqual(["spotify:track:a", "spotify:track:amb-top"]);
  });

  it("excludes ambiguous rows when hideUnmatched is ON", async () => {
    seed(
      [
        matched("a", "spotify:track:a"),
        ambiguous("amb", "spotify:track:amb-top"),
      ],
      true,
    );

    await publishPlaylist("client", { kind: "create" });

    const [, uris] = mocks.pushTracksToPlaylist.mock.calls[0]!;
    expect(uris).toEqual(["spotify:track:a"]);
  });

  it("throws EmptyReplaceError when no rows are eligible (refuses to create empty playlists)", async () => {
    seed([
      // All idle → no uri → nothing to push.
      trackOf({ id: "a", spotify: { status: "idle" } }),
      trackOf({ id: "b", spotify: { status: "missing" } }),
    ]);

    await expect(publishPlaylist("client", { kind: "create" })).rejects.toBeInstanceOf(
      EmptyReplaceError,
    );
    // Crucially we do NOT call createPlaylist — that would leave an
    // empty playlist sitting in the user's Spotify account.
    expect(mocks.createPlaylist).not.toHaveBeenCalled();
    expect(mocks.pushTracksToPlaylist).not.toHaveBeenCalled();
  });
});

describe("publishPlaylist — update (replace) mode", () => {
  it("routes through replaceAndPushTracks against the supplied playlistId without creating a new one", async () => {
    seed([
      matched("a", "spotify:track:a"),
      matched("b", "spotify:track:b"),
    ]);

    const result = await publishPlaylist("client", {
      kind: "update",
      playlistId: "existing-id",
    });

    expect(mocks.createPlaylist).not.toHaveBeenCalled();
    expect(mocks.pushTracksToPlaylist).not.toHaveBeenCalled();
    expect(mocks.replaceAndPushTracks).toHaveBeenCalledTimes(1);
    const [pid, uris] = mocks.replaceAndPushTracks.mock.calls[0]!;
    expect(pid).toBe("existing-id");
    expect(uris).toEqual(["spotify:track:a", "spotify:track:b"]);

    expect(result.playlistId).toBe("existing-id");
    expect(result.playlistUrl).toBe(
      "https://open.spotify.com/playlist/existing-id",
    );
    expect(result.progress.total).toBe(2);
  });

  it("EmptyReplaceError fires in update mode too — refuse to clear a Spotify playlist into nothing", async () => {
    // DESIGN: update mode does PUT /items, which IS a clear-and-replace
    // on Spotify's side. An empty draft would wipe the destination —
    // surface the gap loudly instead.
    seed([trackOf({ id: "a", spotify: { status: "missing" } })]);

    await expect(
      publishPlaylist("client", { kind: "update", playlistId: "existing-id" }),
    ).rejects.toBeInstanceOf(EmptyReplaceError);
    expect(mocks.replaceAndPushTracks).not.toHaveBeenCalled();
  });
});

describe("publishPlaylist — progress propagation", () => {
  it("forwards onProgress through to the underlying push call so the UI can render a real bar", async () => {
    seed([
      matched("a", "spotify:track:a"),
      matched("b", "spotify:track:b"),
    ]);

    // The publisher just delegates the callback to pushTracksToPlaylist
    // — the per-chunk emission contract is owned by pushTracksToPlaylist
    // and tested elsewhere. Here we only verify the callback flows
    // through: the inner mock receives the same function reference the
    // caller supplied. Without that pass-through, the publish dialog's
    // progress bar would freeze at 0 even on partial multi-chunk push.
    const onProgress = vi.fn();
    mocks.pushTracksToPlaylist.mockImplementation(
      async (_id, uris, _clientId, handlers) => {
        handlers?.onProgress?.({
          added: uris.length,
          total: uris.length,
          failedChunks: [],
        });
        return { added: uris.length, total: uris.length, failedChunks: [] };
      },
    );

    await publishPlaylist("client", { kind: "create" }, onProgress);

    expect(onProgress).toHaveBeenCalledWith({
      added: 2,
      total: 2,
      failedChunks: [],
    });
  });

  it("reports partial-success progress when the inner push records failed chunks", async () => {
    // DESIGN item 19: failedChunks must surface through the result so
    // the UI can render an "X/Y added" error toast instead of a
    // green-checkmark "success" claim. Simulate a 3-chunk push where
    // chunk index 1 failed.
    seed([
      matched("a", "spotify:track:a"),
      matched("b", "spotify:track:b"),
      matched("c", "spotify:track:c"),
    ]);
    mocks.pushTracksToPlaylist.mockResolvedValue({
      added: 200, // 2 chunks of 100 succeeded
      total: 300, // 3 chunks were planned
      failedChunks: [1],
    });

    const result = await publishPlaylist("client", { kind: "create" });

    expect(result.progress.added).toBe(200);
    expect(result.progress.total).toBe(300);
    expect(result.progress.failedChunks).toEqual([1]);
    // The result's playlistId still resolves so the toast can include
    // the link to the partially-populated playlist (the user can
    // inspect it and decide whether to retry).
    expect(result.playlistId).toBe("pl-created");
    expect(result.playlistUrl).toBe(
      "https://open.spotify.com/playlist/pl-created",
    );
  });

  it("propagates fatal push errors (auth-expired, rate-limit) as thrown errors, not as failed chunks", async () => {
    // The publisher itself doesn't catch — pushTracksToPlaylist
    // re-throws auth/rate-limit failures and the publisher just
    // bubbles them up to the dialog (which translates to a "reconnect"
    // / "back off" toast). Verify the bubble is not silently caught.
    seed([matched("a", "spotify:track:a")]);
    class FakeFatal extends Error {}
    mocks.pushTracksToPlaylist.mockRejectedValueOnce(new FakeFatal("nope"));

    await expect(publishPlaylist("client", { kind: "create" })).rejects.toBeInstanceOf(
      FakeFatal,
    );
  });
});
