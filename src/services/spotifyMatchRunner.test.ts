// Covers two behaviors flagged as untested in the quality assessment:
//
//   1. `promoteSingleCandidateMatches` — promotes a stored single-candidate
//      ambiguous row to `matched` without re-hitting the API, fills ONLY
//      missing displayed fields (a prior user edit must survive), and leaves
//      multi-candidate / non-ambiguous rows untouched. It writes source-of-
//      truth display fields, so it must be pinned.
//   2. The transient-failure → `idle` revert in `matchOne`: a rate-limited
//      (or auth-expired) search must NOT strand the row in `missing` — that
//      would exclude it from publishes AND from "re-enrich all". It must
//      revert to `idle` so it's re-enrichable once the circuit closes.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// localStorage polyfill — apiClient.ts reads from it at module init.
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
  pushToast: vi.fn(),
  searchSpotifyForTrack: vi.fn(),
}));

vi.mock("../store/uiStore", () => ({
  useUiStore: {
    getState: () => ({
      pushToast: mocks.pushToast,
      withBusy: async (fn: () => Promise<void>) => fn(),
    }),
  },
}));
vi.mock("../spotify/spotifySearch", () => ({
  searchSpotifyForTrack: mocks.searchSpotifyForTrack,
}));

import { SpotifyRateLimitError } from "../spotify/apiClient";
import {
  promoteSingleCandidateMatches,
  rematchOnSpotify,
} from "./spotifyMatchRunner";
import { usePlaylistStore } from "../store/playlistStore";
import { useSettingsStore } from "../store/settingsStore";
import type { SpotifyCandidate, SpotifyMatch, Track } from "../types";

function candidate(overrides: Partial<SpotifyCandidate> = {}): SpotifyCandidate {
  return {
    id: overrides.id ?? "cand",
    uri: overrides.uri ?? "spotify:track:cand",
    title: overrides.title ?? "Cand Title",
    artist: overrides.artist ?? "Cand Artist",
    album: overrides.album,
    year: overrides.year,
    durationMs: overrides.durationMs,
    coverUrl: overrides.coverUrl,
    previewUrl: overrides.previewUrl,
    score: overrides.score ?? 0.8,
  };
}

function track(id: string, spotify: SpotifyMatch, overrides: Partial<Track> = {}): Track {
  return {
    id,
    source: { kind: "text", rawLine: `Artist ${id} - Title ${id}` },
    title: `Title ${id}`,
    artist: `Artist ${id}`,
    enrichment: { status: "idle" },
    spotify,
    ...overrides,
  };
}

function setTracks(tracks: Track[]): void {
  const tracksById: Record<string, Track> = {};
  for (const t of tracks) tracksById[t.id] = t;
  usePlaylistStore.setState({
    tracksById,
    playlist: {
      ...usePlaylistStore.getState().playlist,
      trackIds: tracks.map((t) => t.id),
    },
  });
}

beforeEach(() => {
  mocks.pushToast.mockReset();
  mocks.searchSpotifyForTrack.mockReset();
  useSettingsStore.setState((state) => ({
    settings: { ...state.settings, spotifyClientId: "client-123" },
  }));
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("promoteSingleCandidateMatches", () => {
  it("promotes a single-candidate ambiguous row to matched and fills missing fields", () => {
    const only = candidate({
      id: "a",
      uri: "spotify:track:a",
      album: "An Album",
      year: 2001,
      durationMs: 123_456,
      coverUrl: "https://cover/a",
    });
    setTracks([
      track("t1", { status: "ambiguous", candidates: [only], score: 0.8 }, {
        // album/year/etc. are missing on the row — promotion should fill them.
        album: undefined,
        year: undefined,
        durationMs: undefined,
      }),
    ]);

    promoteSingleCandidateMatches();

    const t1 = usePlaylistStore.getState().tracksById.t1!;
    expect(t1.spotify.status).toBe("matched");
    expect(t1.spotify.status === "matched" && t1.spotify.uri).toBe("spotify:track:a");
    expect(t1.album).toBe("An Album");
    expect(t1.year).toBe(2001);
    expect(t1.durationMs).toBe(123_456);
    expect(t1.coverUrl).toBe("https://cover/a");
  });

  it("does NOT overwrite a user-edited displayed field (source-of-truth: user edit wins)", () => {
    const only = candidate({ id: "a", uri: "spotify:track:a", title: "Spotify Title" });
    setTracks([
      track("t1", { status: "ambiguous", candidates: [only], score: 0.8 }, {
        title: "My Hand-Edited Title",
      }),
    ]);

    promoteSingleCandidateMatches();

    const t1 = usePlaylistStore.getState().tracksById.t1!;
    expect(t1.spotify.status).toBe("matched");
    // The existing (non-empty) title must survive — fill-missing only.
    expect(t1.title).toBe("My Hand-Edited Title");
  });

  it("leaves multi-candidate and non-ambiguous rows untouched", () => {
    setTracks([
      track("multi", {
        status: "ambiguous",
        candidates: [candidate({ id: "a" }), candidate({ id: "b" })],
        score: 0.7,
      }),
      track("missing", { status: "missing" }),
    ]);

    promoteSingleCandidateMatches();

    const state = usePlaylistStore.getState();
    expect(state.tracksById.multi!.spotify.status).toBe("ambiguous");
    expect(state.tracksById.missing!.spotify.status).toBe("missing");
  });
});

describe("matchOne transient-failure handling", () => {
  it("reverts the row to idle (NOT missing) on a rate-limit error so it stays re-enrichable", async () => {
    setTracks([track("t1", { status: "idle" })]);
    mocks.searchSpotifyForTrack.mockRejectedValue(new SpotifyRateLimitError(60_000));

    await rematchOnSpotify("t1");

    const t1 = usePlaylistStore.getState().tracksById.t1!;
    expect(t1.spotify.status).toBe("idle");
  });

  it("marks the row missing on a genuine non-transient failure", async () => {
    setTracks([track("t1", { status: "idle" })]);
    mocks.searchSpotifyForTrack.mockRejectedValue(new Error("boom"));

    await rematchOnSpotify("t1");

    const t1 = usePlaylistStore.getState().tracksById.t1!;
    expect(t1.spotify.status).toBe("missing");
  });
});
