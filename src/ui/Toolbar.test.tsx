// @vitest-environment happy-dom
//
// Toolbar previously had no tests. Covers:
//   - The `isEnriching = queueDepth>0 || enrichmentRemaining>0` OR branch
//     and the Spotify-remaining region (visible text, NOT a chatty live
//     region — see finding 7).
//   - Disabled states gated on trackCount (clear / refresh / undo).
//   - Clear and Refresh confirm gating: the destructive store action only
//     fires AFTER the ConfirmDialog is confirmed.
//
// We drive the real Zustand stores imperatively and mock only the
// enrichment runner (a real network/queue side effect).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("../services/enrichmentRunner", () => ({
  reenrichAll: vi.fn().mockResolvedValue(undefined),
}));

import { Toolbar } from "./Toolbar";
import { usePlaylistStore } from "../store/playlistStore";
import { useUiStore } from "../store/uiStore";
import type { Track } from "../types";

function localTrack(id: string, status: Track["enrichment"]["status"]): Track {
  return {
    id,
    source: { kind: "file", fileName: `${id}.mp3` },
    title: id,
    artist: "A",
    enrichment: { status },
    spotify: { status: "idle" },
  } as unknown as Track;
}

function seedTracks(tracks: Track[]): void {
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
  usePlaylistStore.setState({
    tracksById: {},
    playlist: { ...usePlaylistStore.getState().playlist, trackIds: [] },
    undoStack: [],
  });
  useUiStore.setState({ enrichmentQueueDepth: 0 });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Toolbar — enriching indicator (isEnriching OR branch)", () => {
  it("shows the enriching region when queueDepth>0 even with zero remaining rows", () => {
    seedTracks([]);
    useUiStore.setState({ enrichmentQueueDepth: 3 });
    render(<Toolbar hiddenCount={0} onPickFolder={() => {}} />);
    expect(screen.getByText(/Enriching ·/)).toBeTruthy();
  });

  it("shows the enriching region when remaining>0 even with an empty queue", () => {
    seedTracks([localTrack("t1", "idle"), localTrack("t2", "pending")]);
    useUiStore.setState({ enrichmentQueueDepth: 0 });
    render(<Toolbar hiddenCount={0} onPickFolder={() => {}} />);
    expect(screen.getByText(/Enriching · 2 remaining/)).toBeTruthy();
  });

  it("hides the enriching region when both signals are quiet", () => {
    seedTracks([localTrack("t1", "matched")]);
    useUiStore.setState({ enrichmentQueueDepth: 0 });
    render(<Toolbar hiddenCount={0} onPickFolder={() => {}} />);
    expect(screen.queryByText(/Enriching ·/)).toBeNull();
  });

  it("the enriching count is NOT a chatty live region (aria-live off)", () => {
    seedTracks([localTrack("t1", "idle")]);
    render(<Toolbar hiddenCount={0} onPickFolder={() => {}} />);
    const region = screen.getByText(/Enriching ·/);
    expect(region.getAttribute("aria-live")).toBe("off");
  });
});

describe("Toolbar — disabled states gated on track count", () => {
  it("disables Clear / Resume / Refresh and Undo when the playlist is empty", () => {
    seedTracks([]);
    render(<Toolbar hiddenCount={0} onPickFolder={() => {}} />);
    expect(
      (screen.getByRole("button", { name: "Playlist is empty" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Nothing to undo" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Nothing to refresh" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("enables the destructive actions once tracks exist", () => {
    seedTracks([localTrack("t1", "idle")]);
    render(<Toolbar hiddenCount={0} onPickFolder={() => {}} />);
    expect(
      (screen.getByRole("button", { name: "Clear playlist" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });
});

describe("Toolbar — confirm gating for destructive actions", () => {
  it("Clear does not wipe the playlist until the confirm dialog is confirmed", () => {
    seedTracks([localTrack("t1", "idle")]);
    const clearPlaylist = vi.fn();
    usePlaylistStore.setState({ clearPlaylist });
    render(<Toolbar hiddenCount={0} onPickFolder={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: "Clear playlist" }));
    // Dialog is up but nothing destructive ran yet.
    expect(clearPlaylist).not.toHaveBeenCalled();
    expect(screen.getByText("Clear playlist?")).toBeTruthy();

    // Confirm.
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(clearPlaylist).toHaveBeenCalledTimes(1);
  });

  it("Refresh confirm nukes enrichment state and re-runs lookups only after confirm", () => {
    seedTracks([localTrack("t1", "idle")]);
    const nukeEnrichmentState = vi.fn();
    usePlaylistStore.setState({ nukeEnrichmentState });
    render(<Toolbar hiddenCount={0} onPickFolder={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: /^Refresh:/ }));
    expect(nukeEnrichmentState).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(nukeEnrichmentState).toHaveBeenCalledTimes(1);
  });

  it("Cancelling the Clear dialog leaves the playlist intact", () => {
    seedTracks([localTrack("t1", "idle")]);
    const clearPlaylist = vi.fn();
    usePlaylistStore.setState({ clearPlaylist });
    render(<Toolbar hiddenCount={0} onPickFolder={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: "Clear playlist" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(clearPlaylist).not.toHaveBeenCalled();
    expect(screen.queryByText("Clear playlist?")).toBeNull();
  });
});
