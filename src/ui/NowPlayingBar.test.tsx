// @vitest-environment happy-dom
//
// Verifies the NowPlayingBar's visibility contract:
//   - Hidden ONLY when no track is current, no audio is playing, and
//     there's no display payload.
//   - Visible the moment any of those is true — so the user always has
//     a Stop control while audio is being produced.
//
// The bar reads from usePlaybackStore directly, which is normally
// initialized via initialize(). We drive the store imperatively here
// so the tests can sweep through all the relevant state combinations
// without standing up a real Player + backends.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { NowPlayingBar } from "./NowPlayingBar";
import { usePlaybackStore } from "../playback/playbackStore";

afterEach(() => {
  cleanup();
  // Reset to idle so cases don't leak state between tests.
  usePlaybackStore.setState({
    currentTrackId: null,
    currentSource: { kind: "none" },
    currentDisplay: null,
    isPlaying: false,
    positionMs: 0,
    durationMs: 0,
    sdk: { status: "off" },
  });
});

function setStore(patch: Partial<ReturnType<typeof usePlaybackStore.getState>>) {
  usePlaybackStore.setState(patch);
}

describe("NowPlayingBar — visibility contract", () => {
  it("renders nothing when the store is idle (no track, no display, not playing)", () => {
    const { container } = render(<NowPlayingBar />);
    expect(container.firstChild).toBeNull();
  });

  it("is visible while a track is loaded but not yet playing (loading phase)", () => {
    setStore({
      currentTrackId: "a",
      currentDisplay: { title: "Title A", artist: "Artist A" },
      currentSource: { kind: "local", objectUrl: "blob://a", label: "Local file" },
      isPlaying: false,
      durationMs: 0,
    });
    render(<NowPlayingBar />);
    expect(screen.getByRole("region", { name: "Now playing" })).toBeTruthy();
    expect(screen.getByText("Title A")).toBeTruthy();
  });

  it("is visible while playing", () => {
    setStore({
      currentTrackId: "a",
      currentDisplay: { title: "Title A", artist: "Artist A" },
      currentSource: { kind: "local", objectUrl: "blob://a", label: "Local file" },
      isPlaying: true,
      durationMs: 200_000,
    });
    render(<NowPlayingBar />);
    expect(screen.getByRole("region", { name: "Now playing" })).toBeTruthy();
  });

  it("is visible while a candidate is playing AND offers a working Stop button", () => {
    setStore({
      currentTrackId: "candidate:spotify:track:xyz",
      currentDisplay: { title: "Cand", artist: "Artist" },
      currentSource: {
        kind: "spotify-sdk",
        uri: "spotify:track:xyz",
        label: "Spotify (full track)",
      },
      isPlaying: true,
      durationMs: 200_000,
    });
    render(<NowPlayingBar />);
    expect(screen.getByRole("region", { name: "Now playing" })).toBeTruthy();
    const stop = screen.getByRole("button", { name: "Stop" });
    expect(stop).toBeTruthy();
    // The Stop button is never disabled — candidate playback is still
    // user-stoppable from the bar.
    expect((stop as HTMLButtonElement).disabled).toBe(false);
  });

  it("DEFENSE IN DEPTH: stays visible when isPlaying is true even if currentDisplay drifted to null", () => {
    // This state should be impossible (the Player keeps them in sync),
    // but the bar's visibility check explicitly tolerates it so a bug
    // in the mirror can't strand audio with no Stop control.
    setStore({
      currentTrackId: "a",
      currentDisplay: null,
      currentSource: { kind: "local", objectUrl: "blob://a", label: "Local file" },
      isPlaying: true,
      durationMs: 200_000,
    });
    render(<NowPlayingBar />);
    expect(screen.getByRole("region", { name: "Now playing" })).toBeTruthy();
    // Stop is still accessible.
    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
  });

  it("DEFENSE IN DEPTH: stays visible when currentTrackId drifted to null but isPlaying is true", () => {
    setStore({
      currentTrackId: null,
      currentDisplay: { title: "Stranded", artist: "Artist" },
      currentSource: {
        kind: "spotify-sdk",
        uri: "spotify:track:x",
        label: "Spotify (full track)",
      },
      isPlaying: true,
      durationMs: 200_000,
    });
    render(<NowPlayingBar />);
    expect(screen.getByRole("region", { name: "Now playing" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
  });
});

describe("NowPlayingBar — toggle button gating", () => {
  it("Pause/Play toggles a real Track id", () => {
    const toggle = vi.fn();
    setStore({
      currentTrackId: "track-a",
      currentDisplay: { title: "A", artist: "X" },
      currentSource: { kind: "local", objectUrl: "blob://a", label: "Local file" },
      isPlaying: true,
      durationMs: 100_000,
      toggle,
    });
    render(<NowPlayingBar />);
    const btn = screen.getByRole("button", { name: "Pause" });
    expect((btn as HTMLButtonElement).disabled).toBe(false);
    btn.click();
    expect(toggle).toHaveBeenCalledWith("track-a");
  });

  it("disables the Pause/Play button for candidate playback", () => {
    setStore({
      currentTrackId: "candidate:spotify:track:xyz",
      currentDisplay: { title: "C", artist: "X" },
      currentSource: {
        kind: "spotify-sdk",
        uri: "spotify:track:xyz",
        label: "Spotify (full track)",
      },
      isPlaying: true,
      durationMs: 100_000,
    });
    render(<NowPlayingBar />);
    const pauseBtn = screen.getByRole("button", { name: "Pause" });
    expect((pauseBtn as HTMLButtonElement).disabled).toBe(true);
  });

  it("Stop always invokes the stop action regardless of target kind", () => {
    const stop = vi.fn();
    setStore({
      currentTrackId: "candidate:spotify:track:xyz",
      currentDisplay: { title: "C", artist: "X" },
      currentSource: {
        kind: "spotify-sdk",
        uri: "spotify:track:xyz",
        label: "Spotify (full track)",
      },
      isPlaying: true,
      durationMs: 100_000,
      stop,
    });
    render(<NowPlayingBar />);
    screen.getByRole("button", { name: "Stop" }).click();
    expect(stop).toHaveBeenCalledTimes(1);
  });
});

describe("NowPlayingBar — seek slider", () => {
  function setSeekable(seek: ReturnType<typeof vi.fn>) {
    setStore({
      currentTrackId: "track-a",
      currentDisplay: { title: "A", artist: "X" },
      currentSource: { kind: "local", objectUrl: "blob://a", label: "Local file" },
      isPlaying: true,
      positionMs: 10_000,
      durationMs: 100_000,
      seek,
    });
  }

  it("dragging the thumb does NOT commit until release (no premature seek)", () => {
    const seek = vi.fn();
    setSeekable(seek);
    render(<NowPlayingBar />);
    const slider = screen.getByRole("slider", { name: "Seek" });
    fireEvent.change(slider, { target: { value: "42000" } });
    // The thumb reflects the drag value, but the seek is deferred.
    expect((slider as HTMLInputElement).value).toBe("42000");
    expect(seek).not.toHaveBeenCalled();
  });

  it("commits the dragged value to seek() on pointer release", () => {
    const seek = vi.fn();
    setSeekable(seek);
    render(<NowPlayingBar />);
    const slider = screen.getByRole("slider", { name: "Seek" });
    fireEvent.change(slider, { target: { value: "42000" } });
    fireEvent.pointerUp(slider);
    expect(seek).toHaveBeenCalledWith(42_000);
  });

  it("commits on keyboard scrub (ArrowRight keyup)", () => {
    const seek = vi.fn();
    setSeekable(seek);
    render(<NowPlayingBar />);
    const slider = screen.getByRole("slider", { name: "Seek" });
    fireEvent.change(slider, { target: { value: "20000" } });
    fireEvent.keyUp(slider, { key: "ArrowRight" });
    expect(seek).toHaveBeenCalledWith(20_000);
  });

  it("a cancelled pointer gesture drops the pending drag (thumb returns to live position)", () => {
    const seek = vi.fn();
    setSeekable(seek);
    render(<NowPlayingBar />);
    const slider = screen.getByRole("slider", { name: "Seek" });
    fireEvent.change(slider, { target: { value: "42000" } });
    fireEvent.pointerCancel(slider);
    // dragValue cleared → slider falls back to the live positionMs (10000).
    expect((slider as HTMLInputElement).value).toBe("10000");
    expect(seek).not.toHaveBeenCalled();
  });

  it("is disabled until duration is known", () => {
    setStore({
      currentTrackId: "track-a",
      currentDisplay: { title: "A", artist: "X" },
      currentSource: { kind: "local", objectUrl: "blob://a", label: "Local file" },
      isPlaying: true,
      positionMs: 0,
      durationMs: 0,
    });
    render(<NowPlayingBar />);
    const slider = screen.getByRole("slider", { name: "Seek" });
    expect((slider as HTMLInputElement).disabled).toBe(true);
  });
});
