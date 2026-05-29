// @vitest-environment happy-dom
//
// Integration test that drives the full chain: Zustand store →
// Player → real HtmlAudioBackend → DOM audio event → store mirror.
//
// The player.test.ts suite only covers the Player class via FakeBackend,
// which is why it shipped a broken HtmlAudioBackend without flagging
// the regression. THIS file is the seam that would have caught it.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetPlaybackStoreForTests,
  usePlaybackStore,
} from "./playbackStore";
import type { Track } from "../types";
import { usePlaylistStore } from "../store/playlistStore";

function makeLocalTrack(id: string): Track {
  // happy-dom's File constructor is good enough for URL.createObjectURL.
  const file = new File(["fake-mp3-bytes"], `${id}.mp3`, { type: "audio/mpeg" });
  return {
    id,
    source: { kind: "file", fileName: `${id}.mp3` },
    title: `Title ${id}`,
    artist: `Artist ${id}`,
    durationMs: 200_000,
    localFile: file,
    spotify: { status: "idle" },
    enrichment: { status: "idle" },
  };
}

function seedTrack(track: Track): void {
  usePlaylistStore.setState((s) => ({
    ...s,
    tracksById: { ...s.tracksById, [track.id]: track },
    playlist: { ...s.playlist, trackIds: [...s.playlist.trackIds, track.id] },
  }));
}

let originalAudio: typeof Audio;

beforeEach(() => {
  // Discard the Player instance so each test starts fresh — otherwise
  // a "play track A" in test N leaves "currentTrackId=A, phase=playing"
  // visible to test N+1, and toggle("A") would pause instead of play.
  __resetPlaybackStoreForTests();
  usePlaylistStore.setState((s) => ({ ...s, tracksById: {}, playlist: { ...s.playlist, trackIds: [] } }));

  // Patch the global Audio constructor: in happy-dom, `audio.play()`
  // resolves but does NOT auto-dispatch a `play` DOM event. Patch the
  // prototype so the event is fired when play() is invoked — that's
  // the contract real browsers honor.
  originalAudio = globalThis.Audio;
  const realPlay = HTMLMediaElement.prototype.play;
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(function (
    this: HTMLAudioElement,
  ) {
    queueMicrotask(() => this.dispatchEvent(new Event("play")));
    return Promise.resolve();
  });
  void realPlay; // silence unused warning
});

afterEach(() => {
  vi.restoreAllMocks();
  globalThis.Audio = originalAudio;
});

describe("playback integration — store → Player → real HtmlAudioBackend → audio event → store mirror", () => {
  it("clicking play on a track flips isPlaying to true through the full chain", async () => {
    const track = makeLocalTrack("a");
    seedTrack(track);
    usePlaybackStore.getState().initialize();

    usePlaybackStore.getState().toggle("a");

    // Drain microtasks so the queued op + the play-event dispatch land.
    for (let i = 0; i < 20; i++) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    for (let i = 0; i < 20; i++) await Promise.resolve();

    const state = usePlaybackStore.getState();
    expect(state.currentTrackId).toBe("a");
    expect(state.isPlaying).toBe(true);
    expect(state.currentSource.kind).toBe("local");
    expect(state.currentDisplay?.title).toBe("Title a");
  });

  it("clicking play, then play on the same track again, pauses it", async () => {
    const track = makeLocalTrack("a");
    seedTrack(track);
    usePlaybackStore.getState().initialize();

    usePlaybackStore.getState().toggle("a");
    for (let i = 0; i < 20; i++) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(usePlaybackStore.getState().isPlaying).toBe(true);

    // Second toggle should pause. Make pause fire a 'pause' DOM event.
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(function (
      this: HTMLAudioElement,
    ) {
      this.dispatchEvent(new Event("pause"));
    });

    usePlaybackStore.getState().toggle("a");
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(usePlaybackStore.getState().isPlaying).toBe(false);
    expect(usePlaybackStore.getState().currentTrackId).toBe("a");
  });

  it("clicking play on track B while track A is playing switches cleanly to B", async () => {
    const a = makeLocalTrack("a");
    const b = makeLocalTrack("b");
    seedTrack(a);
    seedTrack(b);
    usePlaybackStore.getState().initialize();

    usePlaybackStore.getState().toggle("a");
    for (let i = 0; i < 20; i++) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(usePlaybackStore.getState().currentTrackId).toBe("a");

    usePlaybackStore.getState().toggle("b");
    for (let i = 0; i < 20; i++) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(usePlaybackStore.getState().currentTrackId).toBe("b");
    expect(usePlaybackStore.getState().isPlaying).toBe(true);
  });

  it("stop() clears the current track and isPlaying drops to false", async () => {
    const track = makeLocalTrack("a");
    seedTrack(track);
    usePlaybackStore.getState().initialize();

    usePlaybackStore.getState().toggle("a");
    for (let i = 0; i < 20; i++) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    for (let i = 0; i < 20; i++) await Promise.resolve();

    usePlaybackStore.getState().stop();
    for (let i = 0; i < 20; i++) await Promise.resolve();

    const state = usePlaybackStore.getState();
    expect(state.currentTrackId).toBeNull();
    expect(state.isPlaying).toBe(false);
  });
});
