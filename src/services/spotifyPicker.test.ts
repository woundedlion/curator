// Tests for the manual Spotify picker — the "user has chosen which
// candidate this row points at" path. DESIGN §4.5 (item 12) makes this
// path identity-changing: picking sets the URI, promotes the row to
// matched, AND invalidates the MB cache because the row's MB identity
// is now derived from the chosen Spotify candidate, not the originally
// imported title/artist/album.
//
// The contracts verified here:
//   1. Display fields (title/artist/album/year/durationMs/coverUrl)
//      are written from the chosen candidate so the row reads as the
//      Spotify-authoritative identity (matches the auto-match runner).
//   2. spotify.uri becomes the picked candidate's URI and status flips
//      to "matched" with the full candidates array preserved.
//   3. enrichment is reset to idle — the prior MB match (if any) is
//      stale because the row's identity just changed.
//   4. The MB cache for the row's identity is deleted, so the
//      re-enrichment fetches fresh candidates rather than serving the
//      previous identity's cached set.
//   5. MB re-enrichment runs with bypassCache: true for defence in
//      depth (cache key may still collide with the old identity if
//      the new candidate carries the same title/artist).
//   6. When no MB contact email is configured the picker still
//      applies the candidate but skips MB re-enrichment (the runner
//      would otherwise warn-toast on every pick).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SpotifyCandidate, Track } from "../types";

const mocks = vi.hoisted(() => ({
  deleteCachedCandidates: vi.fn<(key: unknown) => Promise<void>>(),
  enrichOneTrackMb: vi.fn<
    (trackId: string, options?: { bypassCache?: boolean }) => Promise<"matched">
  >(),
}));

vi.mock("../db/musicbrainzCache", () => ({
  deleteCachedCandidates: mocks.deleteCachedCandidates,
  // cacheKeyForTrack is called by the picker before the delete. The
  // picker passes whatever object this returns straight to
  // deleteCachedCandidates, so a passthrough identity is enough for
  // the test to assert the mock was called with the row's identity
  // fields.
  cacheKeyForTrack: (track: Track) => ({
    title: track.title,
    artist: track.artist,
    album: track.album,
  }),
}));

vi.mock("./enrichmentRunner", () => ({
  enrichOneTrackMb: mocks.enrichOneTrackMb,
}));

import { pickSpotifyCandidate, unpickSpotifyMatch } from "./spotifyPicker";
import { usePlaylistStore } from "../store/playlistStore";
import { useSettingsStore } from "../store/settingsStore";

function trackOf(fields: Partial<Track> & { id: string }): Track {
  return {
    source: { kind: "text" },
    enrichment: { status: "idle" },
    spotify: { status: "idle" },
    ...fields,
  };
}

function candidate(overrides: Partial<SpotifyCandidate> = {}): SpotifyCandidate {
  return {
    uri: "spotify:track:new-candidate",
    id: "new-candidate",
    title: "New Title",
    artist: "New Artist",
    album: "New Album",
    year: 2024,
    durationMs: 200_000,
    coverUrl: "https://example.test/cover.jpg",
    previewUrl: "https://example.test/preview.mp3",
    score: 0.95,
    ...overrides,
  };
}

function seedTrack(track: Track): void {
  usePlaylistStore.setState({
    tracksById: { [track.id]: track },
    playlist: {
      ...usePlaylistStore.getState().playlist,
      trackIds: [track.id],
    },
  });
}

beforeEach(() => {
  mocks.deleteCachedCandidates.mockReset();
  mocks.deleteCachedCandidates.mockResolvedValue(undefined);
  mocks.enrichOneTrackMb.mockReset();
  mocks.enrichOneTrackMb.mockResolvedValue("matched");

  // Default: a contact email is configured so the MB re-enrichment
  // path runs. Individual tests blank it out to exercise the
  // skip-when-no-contact branch.
  useSettingsStore.setState((state) => ({
    settings: {
      ...state.settings,
      musicbrainzContact: "me@example.test",
      spotifyClientId: "client",
    },
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
  usePlaylistStore.setState({
    tracksById: {},
    playlist: {
      ...usePlaylistStore.getState().playlist,
      trackIds: [],
    },
  });
});

describe("pickSpotifyCandidate — identity-change contract (DESIGN §4.5 item 12)", () => {
  it("writes the candidate's display fields onto the row", async () => {
    seedTrack(
      trackOf({
        id: "t1",
        title: "Old Title",
        artist: "Old Artist",
        album: "Old Album",
        year: 1999,
        durationMs: 100_000,
        coverUrl: "https://example.test/old.jpg",
      }),
    );

    const picked = candidate({
      title: "Karma Police",
      artist: "Radiohead",
      album: "OK Computer",
      year: 1997,
      durationMs: 261_000,
      coverUrl: "https://example.test/karma.jpg",
    });

    await pickSpotifyCandidate("t1", picked, [picked]);

    const row = usePlaylistStore.getState().tracksById["t1"]!;
    // updateTrack overwrites fields (it does NOT use the
    // fillMissingDisplayFields preserve-existing semantics — picking
    // is an explicit user decision that must take effect even when
    // the row already has values).
    expect(row.title).toBe("Karma Police");
    expect(row.artist).toBe("Radiohead");
    expect(row.album).toBe("OK Computer");
    expect(row.year).toBe(1997);
    expect(row.durationMs).toBe(261_000);
    expect(row.coverUrl).toBe("https://example.test/karma.jpg");
  });

  it("updates spotify.uri to the picked candidate's URI and promotes to matched", async () => {
    seedTrack(
      trackOf({
        id: "t1",
        spotify: {
          status: "ambiguous",
          uri: "spotify:track:old",
          candidates: [],
          score: 0.5,
        },
      }),
    );

    const picked = candidate({
      uri: "spotify:track:chosen",
      previewUrl: "https://example.test/p.mp3",
      score: 0.42,
    });
    const all = [picked, candidate({ uri: "spotify:track:other", id: "o" })];

    await pickSpotifyCandidate("t1", picked, all);

    const row = usePlaylistStore.getState().tracksById["t1"]!;
    const match = row.spotify;
    expect(match.status).toBe("matched");
    if (match.status !== "matched") throw new Error("unreachable");
    expect(match.uri).toBe("spotify:track:chosen");
    expect(match.score).toBe(0.42);
    expect(match.previewUrl).toBe("https://example.test/p.mp3");
    // Full candidates list is preserved on the row so the picker can
    // be reopened later showing the same set.
    expect(match.candidates).toEqual(all);
  });

  it("resets enrichment to idle (prior MB match is stale because identity just changed)", async () => {
    seedTrack(
      trackOf({
        id: "t1",
        enrichment: {
          status: "matched",
          mbRecordingId: "stale-rec",
          score: 0.88,
        },
      }),
    );

    await pickSpotifyCandidate("t1", candidate(), [candidate()]);

    const row = usePlaylistStore.getState().tracksById["t1"]!;
    expect(row.enrichment.status).toBe("idle");
    // The stale MB recording id is wiped — idle has no mbRecordingId
    // by construction, so the union arm itself enforces this. Keeping
    // it would let the MB column render a green check for a recording
    // derived from the OLD title/artist/album.
    if (row.enrichment.status === "matched") {
      throw new Error("expected idle, not matched");
    }
  });

  it("clears the MB cache for the row's PRE-PICK identity", async () => {
    seedTrack(
      trackOf({
        id: "t1",
        title: "Old Title",
        artist: "Old Artist",
        album: "Old Album",
      }),
    );

    await pickSpotifyCandidate("t1", candidate(), [candidate()]);

    expect(mocks.deleteCachedCandidates).toHaveBeenCalledTimes(1);
    // Cache key MUST reflect the pre-pick identity. The entry that
    // exists in IDB was written by the original enrichment under the
    // OLD title/artist/album tuple; keying the delete off the new
    // identity would leave that stale entry resident and slowly leak.
    const key = mocks.deleteCachedCandidates.mock.calls[0]![0] as {
      title?: string;
      artist?: string;
      album?: string;
    };
    expect(key.title).toBe("Old Title");
    expect(key.artist).toBe("Old Artist");
    expect(key.album).toBe("Old Album");
  });

  it("triggers MB re-enrichment with bypassCache: true", async () => {
    seedTrack(trackOf({ id: "t1" }));

    await pickSpotifyCandidate("t1", candidate(), [candidate()]);

    // withBusy wraps an async function; the runner awaits it but the
    // picker fires it as `void useUiStore.getState().withBusy(...)`.
    // We don't await the runner here, but withBusy invokes the inner
    // work synchronously enough that the mock has been called by the
    // time pickSpotifyCandidate resolves. To be safe, flush
    // microtasks before asserting.
    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.enrichOneTrackMb).toHaveBeenCalledTimes(1);
    expect(mocks.enrichOneTrackMb).toHaveBeenCalledWith("t1", {
      bypassCache: true,
    });
  });

  it("skips MB re-enrichment when no contact email is configured", async () => {
    useSettingsStore.setState((state) => ({
      settings: { ...state.settings, musicbrainzContact: "  " },
    }));
    seedTrack(trackOf({ id: "t1" }));

    await pickSpotifyCandidate("t1", candidate(), [candidate()]);
    await Promise.resolve();
    await Promise.resolve();

    // Identity was still applied (the user's pick is honored)…
    const row = usePlaylistStore.getState().tracksById["t1"]!;
    const match = row.spotify;
    expect(match.status).toBe("matched");
    if (match.status === "matched") {
      expect(match.uri).toBe("spotify:track:new-candidate");
    }
    expect(row.enrichment.status).toBe("idle");
    // …but the runner is NOT invoked. Without a contact email the
    // MB runner would otherwise just warn-toast immediately.
    expect(mocks.enrichOneTrackMb).not.toHaveBeenCalled();
  });

  it("no-ops gracefully when the track was deleted between the picker opening and the pick", async () => {
    // The user can close the picker, the row gets nuked / cleared,
    // and a delayed pick can still fire. The picker reads via
    // tracksById[id] and returns early on miss — verify nothing in
    // the system crashes and no enrichment is queued.
    seedTrack(trackOf({ id: "t1" }));
    usePlaylistStore.setState({
      tracksById: {},
      playlist: {
        ...usePlaylistStore.getState().playlist,
        trackIds: [],
      },
    });

    await expect(
      pickSpotifyCandidate("t1", candidate(), [candidate()]),
    ).resolves.toBeUndefined();
    await Promise.resolve();
    await Promise.resolve();

    // clearMbCacheForCurrentIdentity also early-returns on a missing
    // track, so the cache is not touched either.
    expect(mocks.deleteCachedCandidates).not.toHaveBeenCalled();
    // The runner gates on hasContact, not on existence, so it still
    // fires. That's an acceptable behavior — enrichOneTrackMb itself
    // is resilient to missing rows. We don't assert about it here.
  });
});

describe("unpickSpotifyMatch — toggling a match off", () => {
  it("reverts a matched row to the unmatched (missing) state", () => {
    seedTrack(
      trackOf({
        id: "t1",
        spotify: {
          status: "matched",
          uri: "spotify:track:chosen",
          candidates: [candidate()],
          score: 0.9,
          previewUrl: "https://example.test/p.mp3",
        },
      }),
    );

    unpickSpotifyMatch("t1");

    const row = usePlaylistStore.getState().tracksById["t1"]!;
    // "missing" (not "idle") so the row's Spotify glyph stays
    // interactive and the user can reopen the picker to re-match.
    expect(row.spotify.status).toBe("missing");
  });

  it("no-ops when the track was deleted before the unpick fires", () => {
    expect(() => unpickSpotifyMatch("ghost")).not.toThrow();
  });
});
