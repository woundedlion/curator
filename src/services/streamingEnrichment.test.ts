// Verifies that `enrichAllPending` in streaming mode picks up tracks
// the Spotify search promotes to `matched` *while it is still running*
// — not after, not on a second pass. The original bug was that on a
// pure-audio drop (every row at `spotify.idle`), MB enrichment did not
// start until ALL Spotify searches had completed, because the first
// MB pass's eligible set was a snapshot at function entry and was
// empty.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// localStorage polyfill — apiClient.ts touches it at module init.
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

vi.mock("../store/uiStore", () => ({
  useUiStore: {
    getState: () => ({
      pushToast: () => undefined,
      withBusy: async (fn: () => Promise<void>) => fn(),
    }),
  },
}));

const mocks = vi.hoisted(() => ({
  enrichTrack: vi.fn(),
  deleteCachedCandidates: vi.fn(async () => undefined),
  probeCoverArtUrl: vi.fn(async () => ({ kind: "missing" as const })),
}));

vi.mock("../enrichment/enrichmentService", () => ({
  enrichTrack: mocks.enrichTrack,
}));
vi.mock("../db/musicbrainzCache", () => ({
  deleteCachedCandidates: mocks.deleteCachedCandidates,
  cacheKeyForTrack: (track: { title?: string; artist?: string; album?: string }) => ({
    title: track.title,
    artist: track.artist,
    album: track.album,
  }),
}));
vi.mock("../enrichment/coverArt", () => ({
  probeCoverArtUrl: mocks.probeCoverArtUrl,
}));

import { enrichAllPending } from "./enrichmentRunner";
import { usePlaylistStore } from "../store/playlistStore";
import { useSettingsStore } from "../store/settingsStore";
import type { Track } from "../types";

function track(
  id: string,
  opts: {
    spotifyStatus?: "idle" | "matched";
    enrichmentStatus?: "idle" | "matched";
  } = {},
): Track {
  return {
    id,
    source: { kind: "file", fileName: `${id}.mp3` },
    title: `Title ${id}`,
    artist: `Artist ${id}`,
    spotify:
      opts.spotifyStatus === "matched"
        ? {
            status: "matched",
            uri: `spotify:track:${id}`,
            candidates: [],
            score: 1,
          }
        : { status: opts.spotifyStatus ?? "idle" },
    enrichment:
      opts.enrichmentStatus === "matched"
        ? {
            status: "matched",
            mbRecordingId: `mb-${id}`,
            score: 1,
          }
        : { status: opts.enrichmentStatus ?? "idle" },
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

function promoteToMatched(trackId: string): void {
  const t = usePlaylistStore.getState().tracksById[trackId];
  if (!t) return;
  usePlaylistStore.getState().updateTrack(trackId, {
    spotify: {
      status: "matched",
      uri: `spotify:track:${trackId}`,
      candidates: [],
      score: 1,
    },
  });
}

beforeEach(() => {
  mocks.enrichTrack.mockReset();
  mocks.enrichTrack.mockResolvedValue({
    status: "matched",
    candidates: [],
    topScore: 0,
  });
  mocks.deleteCachedCandidates.mockReset();
  mocks.probeCoverArtUrl.mockReset();
  mocks.probeCoverArtUrl.mockResolvedValue({ kind: "missing" });
  // Settings: client id present (so Spotify is "configured"), MB email
  // present (so enrichment isn't blocked).
  useSettingsStore.setState((s) => ({
    ...s,
    settings: {
      ...s.settings,
      spotifyClientId: "client",
      musicbrainzContact: "test@example.com",
    },
  }));
  setTracks([]);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("enrichAllPending — streaming mode (whileActive)", () => {
  it("WITHOUT streaming: only enriches tracks matched at function entry — late-matched tracks are skipped", async () => {
    setTracks([
      track("a", { spotifyStatus: "matched" }), // eligible at entry
      track("b", { spotifyStatus: "idle" }), // NOT eligible at entry
    ]);

    // Start the runner with no whileActive — it should exit after
    // draining the entry-time eligible set.
    const run = enrichAllPending();
    // Mid-run, promote `b` to matched. Without streaming, this is
    // too late — the runner has already moved on.
    setTimeout(() => promoteToMatched("b"), 0);
    await run;

    const enrichedIds = mocks.enrichTrack.mock.calls.map((c) => c[0].id);
    expect(enrichedIds).toEqual(["a"]);
  });

  it("WITH streaming: late-promoted tracks join the enrichment queue mid-run", async () => {
    setTracks([
      track("a", { spotifyStatus: "matched" }), // eligible at entry
      track("b", { spotifyStatus: "idle" }), // promoted while runner is active
      track("c", { spotifyStatus: "idle" }), // promoted later
    ]);

    let producerDone = false;
    const run = enrichAllPending(undefined, {
      whileActive: () => !producerDone,
    });

    // Promote b after a short delay (simulating Spotify search
    // finishing for b mid-MB-enrichment).
    setTimeout(() => promoteToMatched("b"), 30);
    // Promote c after another delay.
    setTimeout(() => promoteToMatched("c"), 90);
    // Signal that the producer is done after both promotions.
    setTimeout(() => {
      producerDone = true;
    }, 150);

    await run;

    const enrichedIds = mocks.enrichTrack.mock.calls.map((c) => c[0].id);
    expect(enrichedIds).toContain("a");
    expect(enrichedIds).toContain("b");
    expect(enrichedIds).toContain("c");
    expect(enrichedIds.length).toBe(3);
  });

  it("WITH streaming: exits promptly once producer signals done AND eligible set is empty", async () => {
    setTracks([track("a", { spotifyStatus: "matched" })]);

    let producerDone = false;
    const run = enrichAllPending(undefined, {
      whileActive: () => !producerDone,
    });
    // Immediately signal done.
    producerDone = true;
    await run;

    // Should have enriched `a` and exited; not stuck polling.
    expect(mocks.enrichTrack).toHaveBeenCalledTimes(1);
  });

  it("WITH streaming: does NOT enrich tracks that never become eligible (Spotify says 'missing')", async () => {
    setTracks([
      track("a", { spotifyStatus: "matched" }),
      track("b", { spotifyStatus: "idle" }),
    ]);

    let producerDone = false;
    const run = enrichAllPending(undefined, {
      whileActive: () => !producerDone,
    });

    // Simulate Spotify deciding b is missing — still not eligible.
    setTimeout(() => {
      usePlaylistStore.getState().updateTrack("b", {
        spotify: { status: "missing" },
      });
      producerDone = true;
    }, 30);

    await run;

    const enrichedIds = mocks.enrichTrack.mock.calls.map((c) => c[0].id);
    expect(enrichedIds).toEqual(["a"]); // only a; b never qualified
  });

  it("SAFETY VALVE: a stuck producer (whileActive stays true, no new eligible tracks) does not spin forever", async () => {
    // Without the bounded idle budget, a producer that reports
    // whileActive() === true indefinitely while never emitting another
    // eligible track would pin the loop in a 20 Hz playlist scan for the
    // life of the tab. The valve must (a) escalate the poll interval and
    // (b) give up past the idle budget so the loop terminates. Use fake
    // timers so we can fast-forward past the 60s budget deterministically.
    vi.useFakeTimers();
    try {
      setTracks([track("a", { spotifyStatus: "matched" })]);

      // Producer never finishes — the ONLY thing that should stop the
      // loop is the safety valve.
      const run = enrichAllPending(undefined, {
        whileActive: () => true,
      });

      // Drive all timers to completion. If the valve is missing this
      // never settles (infinite poll); vitest's fake clock would run out
      // of queued timers only because the loop keeps scheduling more.
      // advanceTimersByTimeAsync past the idle budget lets the valve fire.
      await vi.advanceTimersByTimeAsync(70_000);
      await run;

      // `a` was enriched once at entry; after that the loop idled and
      // then bailed — no busy-spin, no repeat enrichment.
      const callsForA = mocks.enrichTrack.mock.calls.filter(
        (c) => c[0].id === "a",
      );
      expect(callsForA.length).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("each track is enriched AT MOST ONCE per streaming session", async () => {
    setTracks([track("a", { spotifyStatus: "matched" })]);

    let producerDone = false;
    const run = enrichAllPending(undefined, {
      whileActive: () => !producerDone,
    });
    setTimeout(() => {
      producerDone = true;
    }, 100);
    await run;

    const callsForA = mocks.enrichTrack.mock.calls.filter(
      (c) => c[0].id === "a",
    );
    expect(callsForA.length).toBe(1);
  });
});
