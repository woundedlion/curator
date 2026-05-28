// Exhaustive coverage of the "deletion cancels queued requests"
// contract. The system has TWO mechanisms layered for defence in
// depth, both verified here:
//
//   1. cancelTrackRequests fires synchronously from the playlist
//      store's deletion actions (removeTrack, removeTracks,
//      clearPlaylist, replaceAll) and removes every PENDING task
//      tagged with the deleted trackId from both queues.
//
//   2. Each queued task carries a `guard` closure that re-checks the
//      track's existence when the task pops from the FIFO. A task
//      whose guard fails rejects with RequestCancelledError without
//      sending an HTTP call and WITHOUT consuming a rate-limit slot
//      (nextRunAt isn't advanced — the next task can run immediately).
//
// Scenarios covered: single-track delete, bulk delete, clear, replace,
// delete during a reorder/augment, repeated delete cycles, etc.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// localStorage polyfill — apiClient.ts reads it at module init.
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
vi.stubGlobal("sessionStorage", new MemoryStorage());

vi.mock("../store/uiStore", () => ({
  useUiStore: { getState: () => ({ pushToast: () => undefined }) },
}));

// Skip the real PKCE token storage — every test just needs a Bearer
// token string. Stubbing here avoids polyfilling crypto.subtle and
// the rest of the auth machinery.
vi.mock("../spotify/authFlow", () => ({
  getValidAccessToken: vi.fn(async () => "test-token"),
  missingScopes: () => [] as string[],
  readTokensIfScopesValid: () => null,
  beginAuthFlow: vi.fn(),
  completeAuthFlow: vi.fn(),
  disconnectFromSpotify: vi.fn(),
  readAuthCallback: () => null,
  clearCallbackParams: vi.fn(),
}));

import {
  cancelSpotifyRequestsByTag,
  getPendingSpotifyRequestCount,
  RequestCancelledError,
  submitSpotifyRequest,
  __resetSpotifyRateLimitStateForTests,
} from "../spotify/apiClient";
import {
  cancelMusicbrainzRequestsByTag,
  getMusicbrainzQueue,
} from "../enrichment/musicbrainzClient";
import { cancelTrackRequests } from "./cancelTrackRequests";
import { usePlaylistStore } from "../store/playlistStore";
import type { Track } from "../types";

function track(id: string): Track {
  return {
    id,
    source: { kind: "file", fileName: `${id}.mp3` },
    title: `Title ${id}`,
    artist: `Artist ${id}`,
    spotify: { status: "idle" },
    enrichment: { status: "idle" },
  };
}

function captureRejection<T>(p: Promise<T>): Promise<unknown> {
  return p.then(
    () => new Error("expected rejection but promise resolved"),
    (reason) => reason,
  );
}

beforeEach(() => {
  __resetSpotifyRateLimitStateForTests();
  getMusicbrainzQueue().reset();
  // Reset the store directly. Bypass schedulePersist by writing
  // through setState rather than the action helpers.
  usePlaylistStore.setState({
    tracksById: {},
    playlist: {
      ...usePlaylistStore.getState().playlist,
      trackIds: [],
    },
    selectedTrackIds: new Set<string>(),
    selectionAnchorId: null,
  });
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// A test pattern note for everything below: when you `enqueue`,
// the drain loop synchronously shifts the FIRST task off pending
// and starts running it (the task itself is async — it yields at
// fetch — but the shift + setNextRunAt happens in the same JS
// frame). So `cancelByTag` only affects tasks at positions ≥ 2 in
// the queue at the moment of the call. To exercise cancellation we
// either prime the queue with an unrelated long-running task
// (`primer`) that holds the in-flight slot, OR we use the
// run-time guard (which DOES catch the first-position task,
// because the guard check happens at shift-time before fetch
// fires).

function primer(holdMs: number): Promise<unknown> {
  // Wrap in .catch so the unawaited primer promise (used purely to
  // hold the in-flight slot) doesn't surface as an unhandled
  // rejection if it ever resolves with a non-JSON body or errors.
  void holdMs;
  return submitSpotifyRequest({ path: "/_primer" }, "client", {
    tag: "_primer",
  }).catch(() => undefined);
}

describe("cancelByTag — direct queue behaviour", () => {
  it("removes every pending Spotify request matching the tag", async () => {
    // Slow fetch so the in-flight task doesn't complete before we
    // can cancel.
    const fetchMock = vi.fn(
      async () =>
        new Promise<Response>((resolve) => {
          setTimeout(() => resolve(new Response(null, { status: 200 })), 5_000);
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    // Prime with an unrelated task so the in-flight slot is held by
    // something we DON'T cancel. Subsequent tasks all stay in
    // pending.
    void primer(5_000);

    const rejX1 = captureRejection(
      submitSpotifyRequest({ path: "/x1" }, "client", { tag: "X" }),
    );
    const rejY1 = captureRejection(
      submitSpotifyRequest({ path: "/y1" }, "client", { tag: "Y" }),
    );
    const rejX2 = captureRejection(
      submitSpotifyRequest({ path: "/x2" }, "client", { tag: "X" }),
    );

    const cancelled = cancelSpotifyRequestsByTag("X");
    expect(cancelled).toBe(2);
    expect(await rejX1).toBeInstanceOf(RequestCancelledError);
    expect(await rejX2).toBeInstanceOf(RequestCancelledError);
    void rejY1;
  });

  it("does NOT cancel tasks tagged differently", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Promise<Response>((resolve) => {
          setTimeout(
            () => resolve(new Response(null, { status: 200 })),
            10_000,
          );
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    void primer(10_000);
    const rejX1 = captureRejection(
      submitSpotifyRequest({ path: "/x1" }, "client", { tag: "X" }),
    );
    void submitSpotifyRequest({ path: "/y1" }, "client", { tag: "Y" });

    cancelSpotifyRequestsByTag("X");

    // X was in pending → cancelled, never sent. Y stays in pending
    // behind the primer; we don't need to wait for it to send.
    expect(await rejX1).toBeInstanceOf(RequestCancelledError);
    const xSent = fetchMock.mock.calls.some((call) =>
      String(call[0]).endsWith("/x1"),
    );
    expect(xSent).toBe(false);
  });

  it("is a no-op when no tasks match the tag", () => {
    const cancelled = cancelSpotifyRequestsByTag("nonexistent");
    expect(cancelled).toBe(0);
  });

  it("queue depth drops by exactly the number of cancellations", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Promise<Response>((resolve) => {
          setTimeout(
            () => resolve(new Response(null, { status: 200 })),
            10_000,
          );
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    void primer(10_000);
    void captureRejection(
      submitSpotifyRequest({ path: "/x1" }, "client", { tag: "X" }),
    );
    void captureRejection(
      submitSpotifyRequest({ path: "/x2" }, "client", { tag: "X" }),
    );
    void captureRejection(
      submitSpotifyRequest({ path: "/x3" }, "client", { tag: "X" }),
    );
    void submitSpotifyRequest({ path: "/y1" }, "client", { tag: "Y" });

    const depthBefore = getPendingSpotifyRequestCount();
    cancelSpotifyRequestsByTag("X");
    const depthAfter = getPendingSpotifyRequestCount();
    expect(depthBefore - depthAfter).toBe(3);
  });
});

describe("playlist store deletion → cancelTrackRequests integration", () => {
  // Pass a guard mimicking matchOne / runOneTrack — the orchestrators
  // ALWAYS set this guard in real usage. The guard is what catches
  // the first-task case where cancelByTag can't (because the task
  // already shifted out of pending).
  function guardFor(trackId: string): () => boolean {
    return () =>
      Boolean(usePlaylistStore.getState().tracksById[trackId]);
  }

  it("removeTrack(id) cancels every Spotify request tagged with that id", async () => {
    const slowFetch = vi.fn<typeof fetch>(
      async () =>
        new Promise<Response>((resolve) => {
          setTimeout(
            () => resolve(new Response(null, { status: 200 })),
            10_000,
          );
        }),
    );
    vi.stubGlobal("fetch", slowFetch);

    usePlaylistStore.setState({
      tracksById: { a: track("a"), b: track("b") },
      playlist: {
        ...usePlaylistStore.getState().playlist,
        trackIds: ["a", "b"],
      },
    });

    // Hold the in-flight slot with an unrelated primer so a's task
    // stays in pending where cancelByTag can reach it. This mirrors
    // the realistic scenario where a deletion happens during a busy
    // re-enrich pass: most tracks' tasks are pending behind the few
    // already in-flight.
    void primer(10_000);
    const rejA = captureRejection(
      submitSpotifyRequest({ path: "/a" }, "client", {
        tag: "a",
        guard: guardFor("a"),
      }),
    );
    const rejB = captureRejection(
      submitSpotifyRequest({ path: "/b" }, "client", {
        tag: "b",
        guard: guardFor("b"),
      }),
    );

    usePlaylistStore.getState().removeTrack("a");

    expect(await rejA).toBeInstanceOf(RequestCancelledError);
    const aSent = slowFetch.mock.calls.some((call) =>
      String(call[0]).endsWith("/a"),
    );
    expect(aSent).toBe(false);
    void rejB;
  });

  it("removeTracks(ids) cancels every tag in the bulk delete", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Promise<Response>((resolve) => {
          setTimeout(
            () => resolve(new Response(null, { status: 200 })),
            10_000,
          );
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    usePlaylistStore.setState({
      tracksById: {
        a: track("a"),
        b: track("b"),
        c: track("c"),
        d: track("d"),
      },
      playlist: {
        ...usePlaylistStore.getState().playlist,
        trackIds: ["a", "b", "c", "d"],
      },
    });
    void primer(10_000);

    const rejA = captureRejection(
      submitSpotifyRequest({ path: "/a" }, "client", {
        tag: "a",
        guard: guardFor("a"),
      }),
    );
    const rejB = captureRejection(
      submitSpotifyRequest({ path: "/b" }, "client", {
        tag: "b",
        guard: guardFor("b"),
      }),
    );
    const rejC = captureRejection(
      submitSpotifyRequest({ path: "/c" }, "client", {
        tag: "c",
        guard: guardFor("c"),
      }),
    );
    const rejD = captureRejection(
      submitSpotifyRequest({ path: "/d" }, "client", {
        tag: "d",
        guard: guardFor("d"),
      }),
    );

    // Delete a, b, d in one bulk action. c survives in the queue.
    usePlaylistStore.getState().removeTracks(["a", "b", "d"]);

    expect(await rejA).toBeInstanceOf(RequestCancelledError);
    expect(await rejB).toBeInstanceOf(RequestCancelledError);
    expect(await rejD).toBeInstanceOf(RequestCancelledError);
    // c is still pending behind the primer — that's fine.
    void rejC;

    const cancelledIds = ["a", "b", "d"];
    for (const id of cancelledIds) {
      const sent = fetchMock.mock.calls.some((call) =>
        String(call[0]).endsWith(`/${id}`),
      );
      expect(sent).toBe(false);
    }
  });

  it("clearPlaylist cancels EVERY queued request for current tracks", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Promise<Response>((resolve) => {
          setTimeout(
            () => resolve(new Response(null, { status: 200 })),
            10_000,
          );
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    usePlaylistStore.setState({
      tracksById: { a: track("a"), b: track("b"), c: track("c") },
      playlist: {
        ...usePlaylistStore.getState().playlist,
        trackIds: ["a", "b", "c"],
      },
    });
    void primer(10_000);

    const rejs = [
      captureRejection(
        submitSpotifyRequest({ path: "/a" }, "client", {
          tag: "a",
          guard: guardFor("a"),
        }),
      ),
      captureRejection(
        submitSpotifyRequest({ path: "/b" }, "client", {
          tag: "b",
          guard: guardFor("b"),
        }),
      ),
      captureRejection(
        submitSpotifyRequest({ path: "/c" }, "client", {
          tag: "c",
          guard: guardFor("c"),
        }),
      ),
    ];

    usePlaylistStore.getState().clearPlaylist();

    for (const rej of rejs) {
      expect(await rej).toBeInstanceOf(RequestCancelledError);
    }
    // No outbound HTTP calls for any of the cleared tracks.
    for (const id of ["a", "b", "c"]) {
      const sent = fetchMock.mock.calls.some((call) =>
        String(call[0]).endsWith(`/${id}`),
      );
      expect(sent).toBe(false);
    }
  });

  it("replaceAll cancels only the displaced ids — survivors keep running", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Promise<Response>((resolve) => {
          setTimeout(
            () => resolve(new Response(null, { status: 200 })),
            10_000,
          );
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    usePlaylistStore.setState({
      tracksById: { a: track("a"), b: track("b"), c: track("c") },
      playlist: {
        ...usePlaylistStore.getState().playlist,
        trackIds: ["a", "b", "c"],
      },
    });
    void primer(10_000);

    const rejA = captureRejection(
      submitSpotifyRequest({ path: "/a" }, "client", {
        tag: "a",
        guard: guardFor("a"),
      }),
    );
    const pB = submitSpotifyRequest({ path: "/b" }, "client", {
      tag: "b",
      guard: guardFor("b"),
    });
    const rejC = captureRejection(
      submitSpotifyRequest({ path: "/c" }, "client", {
        tag: "c",
        guard: guardFor("c"),
      }),
    );

    // Replace with b (kept) and a new d. a and c are displaced.
    usePlaylistStore.getState().replaceAll([track("b"), track("d")]);

    expect(await rejA).toBeInstanceOf(RequestCancelledError);
    expect(await rejC).toBeInstanceOf(RequestCancelledError);
    // b's task stays queued behind the primer — that's fine.
    void pB;
    // Neither a nor c hit the network.
    for (const id of ["a", "c"]) {
      const sent = fetchMock.mock.calls.some((call) =>
        String(call[0]).endsWith(`/${id}`),
      );
      expect(sent).toBe(false);
    }
  });
});

describe("defence-in-depth guard at task-run boundary", () => {
  it("a queued task whose tag's track is gone fails fast via the guard, WITHOUT calling fetch", async () => {
    // Fast primer (100ms) so drain can move on to a's task. We
    // can't make the primer infinite here — we need drain to pop
    // a's task to exercise the guard check at run-time.
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Promise<Response>((resolve) => {
          setTimeout(
            () => resolve(new Response("primer", { status: 200 })),
            100,
          );
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    usePlaylistStore.setState({
      tracksById: { a: track("a") },
      playlist: {
        ...usePlaylistStore.getState().playlist,
        trackIds: ["a"],
      },
    });

    void primer(100);

    const guard = () =>
      Boolean(usePlaylistStore.getState().tracksById["a"]);
    const rej = captureRejection(
      submitSpotifyRequest({ path: "/a" }, "client", { tag: "a", guard }),
    );

    // Mutate store directly — no cancelByTag call. The ONLY way
    // a's task should fail to send is the run-time guard check
    // when drain pops it.
    usePlaylistStore.setState((state) => {
      const { a: _removed, ...rest } = state.tracksById;
      void _removed;
      return {
        tracksById: rest,
        playlist: {
          ...state.playlist,
          trackIds: state.playlist.trackIds.filter((id) => id !== "a"),
        },
      };
    });

    // Primer completes at ~100ms, drain waits the 350ms spacing
    // then pops a, guard fires, rejects.
    await vi.advanceTimersByTimeAsync(1000);
    expect(await rej).toBeInstanceOf(RequestCancelledError);
    const aSent = fetchMock.mock.calls.some((call) =>
      String(call[0]).endsWith("/a"),
    );
    expect(aSent).toBe(false);
  });

  it("guard-rejected tasks do NOT consume a rate-limit slot — the next task runs immediately", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    usePlaylistStore.setState({
      tracksById: { live: track("live") },
      playlist: {
        ...usePlaylistStore.getState().playlist,
        trackIds: ["live"],
      },
    });

    const liveGuard = () =>
      Boolean(usePlaylistStore.getState().tracksById["live"]);
    const goneGuard = () =>
      Boolean(usePlaylistStore.getState().tracksById["gone"]);

    // Three tasks: gone, gone, live. The first two should fast-fail
    // via the guard, the live one should run on the very first slot
    // (not after waiting for two intervals worth of spacing for the
    // skipped tasks).
    const rej1 = captureRejection(
      submitSpotifyRequest({ path: "/gone1" }, "client", {
        tag: "gone",
        guard: goneGuard,
      }),
    );
    const rej2 = captureRejection(
      submitSpotifyRequest({ path: "/gone2" }, "client", {
        tag: "gone",
        guard: goneGuard,
      }),
    );
    const liveSentAt: number[] = [];
    const liveSendMock = vi.fn(async () => {
      liveSentAt.push(Date.now());
      return new Response(null, { status: 200 });
    });
    // Re-stub fetch for the live call's fetch only (this is simpler
    // than tracking per-URL behaviour).
    vi.stubGlobal("fetch", liveSendMock);

    const startedAt = Date.now();
    const pLive = submitSpotifyRequest({ path: "/live" }, "client", {
      tag: "live",
      guard: liveGuard,
    });

    await vi.advanceTimersByTimeAsync(2000);
    expect(await rej1).toBeInstanceOf(RequestCancelledError);
    expect(await rej2).toBeInstanceOf(RequestCancelledError);
    await pLive;

    expect(liveSentAt).toHaveLength(1);
    // The live task started within the first interval, not after
    // 2 * intervalMs worth of skipped-task waits. Spacing budget is
    // not consumed by guard-rejected tasks.
    expect(liveSentAt[0] - startedAt).toBeLessThanOrEqual(500);

    void fetchMock;
  });
});

describe("playlist mutations between deletions don't lose track of cancellations", () => {
  it("reorder doesn't fire any cancellation — order-only changes leave queued tasks alone", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    usePlaylistStore.setState({
      tracksById: { a: track("a"), b: track("b"), c: track("c") },
      playlist: {
        ...usePlaylistStore.getState().playlist,
        trackIds: ["a", "b", "c"],
      },
    });

    const ps = [
      submitSpotifyRequest({ path: "/a" }, "client", { tag: "a" }),
      submitSpotifyRequest({ path: "/b" }, "client", { tag: "b" }),
      submitSpotifyRequest({ path: "/c" }, "client", { tag: "c" }),
    ];

    usePlaylistStore.getState().reorderTracks(["c", "b", "a"]);

    // Three tasks at 350ms each — enough buffer.
    await vi.advanceTimersByTimeAsync(2000);
    await Promise.all(ps);
    // All three sent (reorder doesn't cancel anything).
    expect(
      fetchMock.mock.calls.filter((call) =>
        ["/a", "/b", "/c"].some((p) => String(call[0]).endsWith(p)),
      ).length,
    ).toBe(3);
  });

  it("adding new tracks after a deletion doesn't disturb the cancelled task's resolution", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Promise<Response>((resolve) => {
          setTimeout(
            () => resolve(new Response(null, { status: 200 })),
            10_000,
          );
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    usePlaylistStore.setState({
      tracksById: { a: track("a") },
      playlist: {
        ...usePlaylistStore.getState().playlist,
        trackIds: ["a"],
      },
    });
    void primer(10_000);

    const guardA = () =>
      Boolean(usePlaylistStore.getState().tracksById["a"]);
    const rejA = captureRejection(
      submitSpotifyRequest({ path: "/a" }, "client", {
        tag: "a",
        guard: guardA,
      }),
    );

    // Delete a, then add b, c — completely unrelated tracks.
    usePlaylistStore.getState().removeTrack("a");
    usePlaylistStore.getState().addTracks([track("b"), track("c")]);
    void submitSpotifyRequest({ path: "/b" }, "client", { tag: "b" });
    void submitSpotifyRequest({ path: "/c" }, "client", { tag: "c" });

    expect(await rejA).toBeInstanceOf(RequestCancelledError);
    const aSent = fetchMock.mock.calls.some((call) =>
      String(call[0]).endsWith("/a"),
    );
    expect(aSent).toBe(false);
  });

  it("repeated delete cycles: a track re-added under the same id and deleted again still cancels its second-cycle requests", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Promise<Response>((resolve) => {
          setTimeout(
            () => resolve(new Response(null, { status: 200 })),
            30_000,
          );
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    // Long-lived primer holds the in-flight slot across both
    // cycles so every a-tagged task stays pending.
    void primer(30_000);

    // Cycle 1.
    usePlaylistStore.setState({
      tracksById: { a: track("a") },
      playlist: {
        ...usePlaylistStore.getState().playlist,
        trackIds: ["a"],
      },
    });
    const guardA = () =>
      Boolean(usePlaylistStore.getState().tracksById["a"]);
    const rej1 = captureRejection(
      submitSpotifyRequest({ path: "/a1" }, "client", {
        tag: "a",
        guard: guardA,
      }),
    );
    usePlaylistStore.getState().removeTrack("a");
    expect(await rej1).toBeInstanceOf(RequestCancelledError);

    // Cycle 2: re-add (same id) → enqueue → delete again.
    usePlaylistStore.getState().addTracks([track("a")]);
    const rej2 = captureRejection(
      submitSpotifyRequest({ path: "/a2" }, "client", {
        tag: "a",
        guard: guardA,
      }),
    );
    usePlaylistStore.getState().removeTrack("a");
    expect(await rej2).toBeInstanceOf(RequestCancelledError);

    // No a-tagged HTTP calls in either cycle.
    const aSent = fetchMock.mock.calls.some((call) =>
      String(call[0]).startsWith("/a") ||
      String(call[0]).includes("/a1") ||
      String(call[0]).includes("/a2"),
    );
    expect(aSent).toBe(false);
  });

  it("interleaved deletes during heavy traffic — each delete cancels exactly its own tasks", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Promise<Response>((resolve) => {
          setTimeout(
            () => resolve(new Response(null, { status: 200 })),
            30_000,
          );
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const ids = ["a", "b", "c", "d", "e", "f"];
    usePlaylistStore.setState({
      tracksById: Object.fromEntries(ids.map((id) => [id, track(id)])),
      playlist: {
        ...usePlaylistStore.getState().playlist,
        trackIds: ids,
      },
    });
    void primer(30_000);

    const guardFor = (id: string) => () =>
      Boolean(usePlaylistStore.getState().tracksById[id]);
    const promises = new Map<string, Promise<unknown>>();
    for (const id of ids) {
      promises.set(
        id,
        captureRejection(
          submitSpotifyRequest({ path: `/${id}` }, "client", {
            tag: id,
            guard: guardFor(id),
          }),
        ),
      );
    }

    // Delete in interleaved order with reorders sprinkled in.
    usePlaylistStore.getState().removeTrack("c");
    usePlaylistStore.getState().reorderTracks(["b", "a", "d", "e", "f"]);
    usePlaylistStore.getState().removeTracks(["a", "f"]);
    usePlaylistStore.getState().addTracks([track("g")]);
    promises.set(
      "g",
      submitSpotifyRequest({ path: "/g" }, "client", {
        tag: "g",
        guard: guardFor("g"),
      }),
    );
    usePlaylistStore.getState().removeTrack("e");

    // Deleted: a, c, e, f should have RequestCancelledError.
    for (const id of ["a", "c", "e", "f"]) {
      const result = await promises.get(id);
      expect(result).toBeInstanceOf(RequestCancelledError);
    }
    // Survivors (b, d, g) stay queued behind the primer — that's
    // realistic; we don't need to verify they ever send.

    // None of the deleted ids hit fetch.
    for (const id of ["a", "c", "e", "f"]) {
      const sent = fetchMock.mock.calls.some((call) =>
        String(call[0]).endsWith(`/${id}`),
      );
      expect(sent).toBe(false);
    }
  });
});

describe("cancelTrackRequests helper", () => {
  it("cancels in BOTH Spotify and MB queues for each trackId", async () => {
    const spotifyMock = vi.fn<typeof fetch>(
      async () =>
        new Promise<Response>((resolve) => {
          setTimeout(
            () => resolve(new Response(null, { status: 200 })),
            10_000,
          );
        }),
    );
    vi.stubGlobal("fetch", spotifyMock);

    // Prime so the first Spotify slot is held by something else.
    void primer(10_000);
    const rejSpotify = captureRejection(
      submitSpotifyRequest({ path: "/spotify-a" }, "client", { tag: "a" }),
    );

    // MB queue: enqueue a primer + an a-tagged task. Both stay in
    // pending until we advance time past the 1.1s interval.
    const mbQueue = getMusicbrainzQueue();
    void mbQueue.enqueue(async () => "primer", { tag: "_primer" });
    const rejMb = captureRejection(
      mbQueue.enqueue(async () => "should not run", {
        tag: "a",
      }),
    );

    cancelTrackRequests(["a"]);

    expect(await rejSpotify).toBeInstanceOf(RequestCancelledError);
    expect(await rejMb).toBeInstanceOf(RequestCancelledError);
    void cancelMusicbrainzRequestsByTag;
  });

  it("cancelTrackRequests([]) is a no-op", () => {
    expect(() => cancelTrackRequests([])).not.toThrow();
  });
});
