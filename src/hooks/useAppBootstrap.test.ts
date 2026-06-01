// @vitest-environment happy-dom
//
// useAppBootstrap previously had no direct tests. It owns the app's
// mount/unmount lifecycle: initialize playback, hydrate the draft, boot
// Spotify, prune caches, observe the MB queue, and wire global listeners
// — then tear ALL of that down on unmount (flush, observers, worker pool,
// playback). This test mocks every heavy dependency and asserts the
// lifecycle symmetry plus the `.catch` guards on the fire-and-forget
// calls (a rejection must not surface as an unhandled rejection).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";

// ─── Mocks for every heavy dependency ───────────────────────────────

const initialize = vi.fn();
const teardownPlayback = vi.fn();
const connectSdk = vi.fn();
const hydrateFromStorage = vi.fn(async () => {});

vi.mock("../playback/playbackStore", () => ({
  usePlaybackStore: {
    getState: () => ({ initialize, teardownPlayback, connectSdk }),
  },
}));

const flushPendingPersist = vi.fn(async () => {});
vi.mock("../store/playlistStore", () => ({
  flushPendingPersist: () => flushPendingPersist(),
  usePlaylistStore: {
    getState: () => ({ hydrateFromStorage }),
  },
}));

const pruneStaleCacheEntries = vi.fn(async () => {});
vi.mock("../db/musicbrainzCache", () => ({
  pruneStaleCacheEntries: () => pruneStaleCacheEntries(),
}));

const observeUnsubscribe = vi.fn();
const observe = vi.fn(() => observeUnsubscribe);
vi.mock("../enrichment/musicbrainzClient", () => ({
  getMusicbrainzQueue: () => ({ observe }),
}));

const bootstrapSpotify = vi.fn(async () => {});
vi.mock("../services/spotifyBootstrap", () => ({
  bootstrapSpotify: () => bootstrapSpotify(),
}));

const promoteSingleCandidateMatches = vi.fn();
vi.mock("../services/spotifyMatchRunner", () => ({
  promoteSingleCandidateMatches: () => promoteSingleCandidateMatches(),
}));

const shutdownAudioParserPool = vi.fn();
vi.mock("../workers/audioParserPool", () => ({
  shutdownAudioParserPool: () => shutdownAudioParserPool(),
}));

// Settings/spotify/ui stores: real-ish lightweight stubs. The SDK-warmup
// branch is gated on preferFullPlayback && clientId && connected; we
// default them off so connectSdk isn't called unless a test opts in.
const settingsState = {
  settings: { preferFullPlayback: false, spotifyClientId: "" },
};
vi.mock("../store/settingsStore", () => ({
  useSettingsStore: { getState: () => settingsState },
}));
const spotifyState = { connected: false };
vi.mock("../store/spotifyStore", () => ({
  useSpotifyStore: { getState: () => spotifyState },
}));
vi.mock("../store/uiStore", () => ({
  useUiStore: {
    getState: () => ({ pushToast: vi.fn(), setEnrichmentQueueDepth: vi.fn() }),
  },
}));

import { useAppBootstrap } from "./useAppBootstrap";

beforeEach(() => {
  vi.clearAllMocks();
  settingsState.settings = { preferFullPlayback: false, spotifyClientId: "" };
  spotifyState.connected = false;
});

afterEach(() => {
  cleanup();
});

// Let the mount's fire-and-forget async chains settle.
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("useAppBootstrap — mount", () => {
  it("initializes playback, hydrates the draft, boots Spotify, prunes cache, observes the queue", async () => {
    renderHook(() => useAppBootstrap());

    expect(initialize).toHaveBeenCalledTimes(1);
    expect(hydrateFromStorage).toHaveBeenCalledTimes(1);
    expect(bootstrapSpotify).toHaveBeenCalledTimes(1);
    expect(pruneStaleCacheEntries).toHaveBeenCalledTimes(1);
    expect(observe).toHaveBeenCalledTimes(1);

    await flushMicrotasks();
    // After hydration resolves, single-candidate matches are promoted.
    expect(promoteSingleCandidateMatches).toHaveBeenCalledTimes(1);
  });

  it("warms the SDK after bootstrap when the user opted into full playback and is connected", async () => {
    settingsState.settings = {
      preferFullPlayback: true,
      spotifyClientId: "cid",
    };
    spotifyState.connected = true;

    renderHook(() => useAppBootstrap());
    await flushMicrotasks();
    expect(connectSdk).toHaveBeenCalledTimes(1);
  });

  it("does NOT warm the SDK when not connected", async () => {
    settingsState.settings = {
      preferFullPlayback: true,
      spotifyClientId: "cid",
    };
    spotifyState.connected = false;

    renderHook(() => useAppBootstrap());
    await flushMicrotasks();
    expect(connectSdk).not.toHaveBeenCalled();
  });
});

describe("useAppBootstrap — unmount teardown symmetry", () => {
  it("tears down observers, the worker pool, and playback on unmount", () => {
    const { unmount } = renderHook(() => useAppBootstrap());
    unmount();
    expect(observeUnsubscribe).toHaveBeenCalledTimes(1);
    expect(shutdownAudioParserPool).toHaveBeenCalledTimes(1);
    expect(teardownPlayback).toHaveBeenCalledTimes(1);
  });

  it("removes the global lifecycle listeners on unmount", () => {
    const removeWin = vi.spyOn(window, "removeEventListener");
    const removeDoc = vi.spyOn(document, "removeEventListener");
    const { unmount } = renderHook(() => useAppBootstrap());
    unmount();
    const winEvents = removeWin.mock.calls.map((c) => c[0]);
    expect(winEvents).toContain("pagehide");
    expect(winEvents).toContain("offline");
    expect(winEvents).toContain("online");
    expect(removeDoc.mock.calls.map((c) => c[0])).toContain(
      "visibilitychange",
    );
    removeWin.mockRestore();
    removeDoc.mockRestore();
  });
});

describe("useAppBootstrap — fire-and-forget .catch guards", () => {
  it("a bootstrapSpotify rejection is caught (no unhandled rejection)", async () => {
    const unhandled = vi.fn();
    window.addEventListener("unhandledrejection", unhandled);
    bootstrapSpotify.mockRejectedValueOnce(new Error("boot failed"));

    renderHook(() => useAppBootstrap());
    await flushMicrotasks();
    expect(unhandled).not.toHaveBeenCalled();
    window.removeEventListener("unhandledrejection", unhandled);
  });

  it("a pruneStaleCacheEntries rejection is caught (no unhandled rejection)", async () => {
    const unhandled = vi.fn();
    window.addEventListener("unhandledrejection", unhandled);
    pruneStaleCacheEntries.mockRejectedValueOnce(new Error("prune failed"));

    renderHook(() => useAppBootstrap());
    await flushMicrotasks();
    expect(unhandled).not.toHaveBeenCalled();
    window.removeEventListener("unhandledrejection", unhandled);
  });
});
