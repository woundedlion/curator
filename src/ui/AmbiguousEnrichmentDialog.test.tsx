// @vitest-environment happy-dom
//
// AmbiguousEnrichmentDialog previously had no tests. It's the MusicBrainz
// candidate picker. Picking a candidate must (per DESIGN §4.3) only FILL
// MISSING display fields (MB is supplementary), set enrichment to
// `matched` with the chosen recording id, mark it a userOverride, and
// close. We drive the real playlist store and assert the resulting state.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("../db/draftRepository", () => ({
  saveDraft: vi.fn(async () => undefined),
  loadDraft: vi.fn(async () => ({ playlist: null, tracks: [] })),
}));
vi.mock("../services/cancelTrackRequests", () => ({
  cancelTrackRequests: vi.fn(),
}));

import { AmbiguousEnrichmentDialog } from "./AmbiguousEnrichmentDialog";
import { usePlaylistStore } from "../store/playlistStore";
import type { MBCandidate, Track } from "../types";

function candidate(over: Partial<MBCandidate> = {}): MBCandidate {
  return {
    recordingId: "rec-1",
    title: "Karma Police",
    artist: "Radiohead",
    album: "OK Computer",
    year: 1997,
    score: 0.9,
    ...over,
  };
}

function seedTrack(track: Track): void {
  usePlaylistStore.setState({
    tracksById: { [track.id]: track },
    playlist: {
      ...usePlaylistStore.getState().playlist,
      trackIds: [track.id],
    },
    undoStack: [],
  });
}

function ambiguousTrack(candidates: MBCandidate[]): Track {
  return {
    id: "t1",
    source: { kind: "text", rawLine: "Radiohead - Karma Police" },
    // Title/artist intentionally absent so fill-missing has something to do.
    enrichment: { status: "ambiguous", candidates, score: 0.5 },
    spotify: { status: "idle" },
  } as unknown as Track;
}

beforeEach(() => {
  usePlaylistStore.setState({
    tracksById: {},
    playlist: { ...usePlaylistStore.getState().playlist, trackIds: [] },
    undoStack: [],
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("AmbiguousEnrichmentDialog", () => {
  it("renders nothing when trackId is null", () => {
    const { container } = render(
      <AmbiguousEnrichmentDialog trackId={null} onClose={() => {}} />,
    );
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it("lists the candidates for the track", () => {
    seedTrack(
      ambiguousTrack([
        candidate(),
        candidate({ recordingId: "rec-2", album: "OK Computer (2017)", year: 2017 }),
      ]),
    );
    render(<AmbiguousEnrichmentDialog trackId="t1" onClose={() => {}} />);
    expect(screen.getByText(/Karma Police — Radiohead · OK Computer \(1997\)/)).toBeTruthy();
    expect(
      screen.getByText(/Karma Police — Radiohead · OK Computer \(2017\) \(2017\)/),
    ).toBeTruthy();
  });

  it("shows an empty-state message when the track has no candidates", () => {
    seedTrack(ambiguousTrack([]));
    render(<AmbiguousEnrichmentDialog trackId="t1" onClose={() => {}} />);
    expect(screen.getByText("No candidates available.")).toBeTruthy();
  });

  it("picking a candidate fills missing fields, sets enrichment matched (userOverride), and closes", () => {
    seedTrack(ambiguousTrack([candidate()]));
    const onClose = vi.fn();
    render(<AmbiguousEnrichmentDialog trackId="t1" onClose={onClose} />);

    fireEvent.click(
      screen.getByRole("button", {
        name: /Karma Police — Radiohead · OK Computer \(1997\)/,
      }),
    );

    const track = usePlaylistStore.getState().tracksById["t1"]!;
    // Missing identity fields were filled from the candidate (MB is
    // supplementary, fill-missing only).
    expect(track.title).toBe("Karma Police");
    expect(track.artist).toBe("Radiohead");
    expect(track.album).toBe("OK Computer");
    expect(track.year).toBe(1997);
    // Enrichment is now a user-confirmed match.
    expect(track.enrichment.status).toBe("matched");
    if (track.enrichment.status === "matched") {
      expect(track.enrichment.mbRecordingId).toBe("rec-1");
      expect(track.enrichment.userOverride).toBe(true);
    }
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Cancel closes without mutating the track", () => {
    seedTrack(ambiguousTrack([candidate()]));
    const onClose = vi.fn();
    render(<AmbiguousEnrichmentDialog trackId="t1" onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(usePlaylistStore.getState().tracksById["t1"]!.enrichment.status).toBe(
      "ambiguous",
    );
  });

  it("clicking the backdrop closes the dialog (== onClose)", () => {
    seedTrack(ambiguousTrack([candidate()]));
    const onClose = vi.fn();
    const { container } = render(
      <AmbiguousEnrichmentDialog trackId="t1" onClose={onClose} />,
    );
    const backdrop = container.querySelector(".fixed.inset-0") as HTMLElement;
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("clicking inside the panel does NOT close the dialog", () => {
    seedTrack(ambiguousTrack([candidate()]));
    const onClose = vi.fn();
    render(<AmbiguousEnrichmentDialog trackId="t1" onClose={onClose} />);
    // Click the heading inside the panel — must not bubble to the backdrop.
    fireEvent.click(screen.getByText("Pick a MusicBrainz match"));
    expect(onClose).not.toHaveBeenCalled();
  });
});
