// @vitest-environment happy-dom
//
// Sidebar previously had no tests. Covers the three rendering branches
// (not connected / loading / list) and the drag-handler wiring that puts
// a playlist id onto the DataTransfer so it can be dropped on the draft.
// We drive the real Zustand stores imperatively (same approach as
// NowPlayingBar.test) rather than mocking modules.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Sidebar } from "./Sidebar";
import { useSpotifyStore } from "../store/spotifyStore";
import { useSettingsStore } from "../store/settingsStore";
import type { SpotifyPlaylistSummary } from "../types";

function playlist(
  id: string,
  name: string,
  trackCount?: number,
): SpotifyPlaylistSummary {
  return { id, name, trackCount, ownerId: "me" };
}

beforeEach(() => {
  useSpotifyStore.setState({
    playlists: [],
    loadingPlaylists: false,
    connected: false,
  });
  useSettingsStore.setState({
    settings: { ...useSettingsStore.getState().settings, spotifyClientId: "cid" },
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Sidebar", () => {
  it("shows the not-connected hint when disconnected", () => {
    useSpotifyStore.setState({ connected: false });
    render(<Sidebar />);
    expect(screen.getByText(/Not connected/i)).toBeTruthy();
    // Refresh button is disabled while disconnected.
    const refresh = screen.getByRole("button", { name: "Refresh playlists" });
    expect((refresh as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows a spinner while loading", () => {
    useSpotifyStore.setState({ connected: true, loadingPlaylists: true });
    render(<Sidebar />);
    expect(screen.getByLabelText("Refreshing playlists")).toBeTruthy();
  });

  it("renders the playlists sorted case-insensitively with track counts", () => {
    useSpotifyStore.setState({
      connected: true,
      loadingPlaylists: false,
      playlists: [
        playlist("2", "beta", 12),
        playlist("1", "Alpha", undefined),
      ],
    });
    render(<Sidebar />);
    const items = screen.getAllByRole("listitem");
    // "Alpha" sorts before "beta" with sensitivity:base.
    expect(items[0]!.textContent).toContain("Alpha");
    expect(items[0]!.textContent).toContain("? tracks");
    expect(items[1]!.textContent).toContain("beta");
    expect(items[1]!.textContent).toContain("12 tracks");
  });

  it("wires the drag handler to stamp the playlist id onto the DataTransfer", () => {
    useSpotifyStore.setState({
      connected: true,
      playlists: [playlist("pl-7", "Roadtrip", 3)],
    });
    render(<Sidebar />);
    const item = screen.getByText("Roadtrip").closest("li")!;

    const setData = vi.fn();
    fireEvent.dragStart(item, {
      dataTransfer: { setData, types: [] },
    });
    // The exact MIME/value is owned by dragData; we just assert the
    // handler ran and wrote the id through to setData.
    expect(setData).toHaveBeenCalled();
    const wroteId = setData.mock.calls.some((call) =>
      call.some((arg) => String(arg).includes("pl-7")),
    );
    expect(wroteId).toBe(true);
  });

  it("exposes the draggable playlist row to assistive tech", () => {
    // The whole <li> is a native drag source with only an inner cursor-grab
    // hint; aria-roledescription announces the affordance to SR users.
    useSpotifyStore.setState({
      connected: true,
      playlists: [playlist("pl-7", "Roadtrip", 3)],
    });
    render(<Sidebar />);
    const item = screen.getByText("Roadtrip").closest("li")!;
    expect(item.getAttribute("aria-roledescription")).toBe("draggable playlist");
  });

  it("refresh button calls loadPlaylists with the configured client id", async () => {
    const loadPlaylists = vi.fn().mockResolvedValue(undefined);
    useSpotifyStore.setState({ connected: true, loadPlaylists });
    render(<Sidebar />);
    screen.getByRole("button", { name: "Refresh playlists" }).click();
    expect(loadPlaylists).toHaveBeenCalledWith("cid");
  });
});
