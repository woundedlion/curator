// @vitest-environment happy-dom
//
// AmbiguousMatchDialog previously had no tests. It's the Spotify version
// picker. Covers: rendering the track's existing candidates, picking a
// candidate (delegates to pickSpotifyCandidate + closes), re-searching with
// edited fields, and the Enter-key race guard added so hammering Enter
// can't fire overlapping searches whose responses resolve out of order.
//
// pickSpotifyCandidate / searchSpotifyCandidatesByFields are mocked (real
// network + store side effects); the stores and the playback store run for
// real (no playback is triggered, so the SDK is never touched).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

vi.mock("../db/draftRepository", () => ({
  saveDraft: vi.fn(async () => undefined),
  loadDraft: vi.fn(async () => ({ playlist: null, tracks: [] })),
}));
vi.mock("../services/cancelTrackRequests", () => ({
  cancelTrackRequests: vi.fn(),
}));
vi.mock("../services/spotifyPicker", () => ({
  pickSpotifyCandidate: vi.fn(async () => undefined),
  unpickSpotifyMatch: vi.fn(() => undefined),
}));
vi.mock("../spotify/spotifySearch", () => ({
  searchSpotifyCandidatesByFields: vi.fn(async () => []),
}));

import { AmbiguousMatchDialog } from "./AmbiguousMatchDialog";
import {
  pickSpotifyCandidate,
  unpickSpotifyMatch,
} from "../services/spotifyPicker";
import { searchSpotifyCandidatesByFields } from "../spotify/spotifySearch";
import { usePlaylistStore } from "../store/playlistStore";
import { useSettingsStore } from "../store/settingsStore";
import type { SpotifyCandidate, Track } from "../types";

function candidate(over: Partial<SpotifyCandidate> = {}): SpotifyCandidate {
  return {
    uri: "spotify:track:aaa",
    id: "aaa",
    title: "Karma Police",
    artist: "Radiohead",
    album: "OK Computer",
    year: 1997,
    durationMs: 261000,
    score: 0.9,
    ...over,
  };
}

function seedTrack(track: Track): void {
  usePlaylistStore.setState({
    tracksById: { [track.id]: track },
    playlist: { ...usePlaylistStore.getState().playlist, trackIds: [track.id] },
    undoStack: [],
  });
}

function ambiguousTrack(candidates: SpotifyCandidate[]): Track {
  return {
    id: "t1",
    source: { kind: "text", rawLine: "Radiohead - Karma Police" },
    title: "Karma Police",
    artist: "Radiohead",
    enrichment: { status: "idle" },
    spotify: { status: "ambiguous", candidates, score: 0.5 },
  } as unknown as Track;
}

beforeEach(() => {
  useSettingsStore.setState({
    settings: { ...useSettingsStore.getState().settings, spotifyClientId: "cid" },
  });
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

describe("AmbiguousMatchDialog", () => {
  it("renders the track's existing candidates without auto-searching", () => {
    seedTrack(ambiguousTrack([candidate(), candidate({ uri: "spotify:track:bbb", id: "bbb", album: "OKNOTOK", year: 2017 })]));
    render(<AmbiguousMatchDialog trackId="t1" onClose={() => {}} />);
    // Both candidate titles render.
    expect(screen.getAllByText("Karma Police").length).toBeGreaterThanOrEqual(2);
    // The existing candidates are shown, so no search was fired on mount.
    expect(searchSpotifyCandidatesByFields).not.toHaveBeenCalled();
  });

  it("picking a candidate delegates to pickSpotifyCandidate and closes", () => {
    const cands = [candidate()];
    seedTrack(ambiguousTrack(cands));
    const onClose = vi.fn();
    render(<AmbiguousMatchDialog trackId="t1" onClose={onClose} />);
    // The candidate's selectable button — its accessible name is the row's
    // text content (title + artist · album · year · duration). The play
    // control for this candidate renders as an external link (no preview,
    // SDK off), so the only /OK Computer/ button is the row body.
    fireEvent.click(screen.getByRole("button", { name: /OK Computer/ }));
    expect(pickSpotifyCandidate).toHaveBeenCalledTimes(1);
    const [trackId, picked] = vi.mocked(pickSpotifyCandidate).mock.calls[0]!;
    expect(trackId).toBe("t1");
    expect(picked.uri).toBe("spotify:track:aaa");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("clicking the already-selected match toggles it off (unmatch) and keeps the dialog open", () => {
    // A matched track whose URI points at candidate `aaa` → that row is
    // the "current" match. Clicking it should unmatch (not re-pick) and
    // NOT close the dialog, so the user can pick another version.
    const cands = [
      candidate(),
      candidate({ uri: "spotify:track:bbb", id: "bbb", album: "OKNOTOK" }),
    ];
    const matched: Track = {
      id: "t1",
      source: { kind: "text", rawLine: "Radiohead - Karma Police" },
      title: "Karma Police",
      artist: "Radiohead",
      enrichment: { status: "idle" },
      spotify: {
        status: "matched",
        uri: "spotify:track:aaa",
        candidates: cands,
        score: 0.9,
      },
    } as unknown as Track;
    seedTrack(matched);
    const onClose = vi.fn();
    render(<AmbiguousMatchDialog trackId="t1" onClose={onClose} />);

    // The current match row carries the "✓ current" marker.
    fireEvent.click(screen.getByRole("button", { name: /OK Computer/ }));

    expect(unpickSpotifyMatch).toHaveBeenCalledTimes(1);
    expect(unpickSpotifyMatch).toHaveBeenCalledWith("t1");
    expect(pickSpotifyCandidate).not.toHaveBeenCalled();
    // Toggling off keeps the dialog open (unlike a pick, which closes).
    expect(onClose).not.toHaveBeenCalled();
  });

  it("Search again fetches with the edited fields and renders the results", async () => {
    seedTrack(ambiguousTrack([candidate()]));
    vi.mocked(searchSpotifyCandidatesByFields).mockResolvedValueOnce([
      candidate({ uri: "spotify:track:ccc", id: "ccc", title: "Lucky", album: "OK Computer" }),
    ]);
    render(<AmbiguousMatchDialog trackId="t1" onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() =>
      expect(searchSpotifyCandidatesByFields).toHaveBeenCalledTimes(1),
    );
    expect(await screen.findByText("Lucky")).toBeTruthy();
  });

  it("REGRESSION: hammering Enter does not fire overlapping searches", async () => {
    seedTrack(ambiguousTrack([candidate()]));
    // First search never resolves, so `searching` stays true.
    vi.mocked(searchSpotifyCandidatesByFields).mockImplementationOnce(
      () => new Promise<SpotifyCandidate[]>(() => {}),
    );
    render(<AmbiguousMatchDialog trackId="t1" onClose={() => {}} />);
    const titleInput = screen.getByPlaceholderText("Title");
    fireEvent.keyDown(titleInput, { key: "Enter" });
    fireEvent.keyDown(titleInput, { key: "Enter" });
    fireEvent.keyDown(titleInput, { key: "Enter" });
    // The in-flight guard means only the first Enter started a search.
    expect(searchSpotifyCandidatesByFields).toHaveBeenCalledTimes(1);
  });

  it("clicking the backdrop closes the dialog (== onClose)", () => {
    seedTrack(ambiguousTrack([candidate()]));
    const onClose = vi.fn();
    const { container } = render(
      <AmbiguousMatchDialog trackId="t1" onClose={onClose} />,
    );
    // The backdrop is the outermost fixed-inset overlay; clicking it
    // (NOT the panel) cancels.
    const backdrop = container.querySelector(".fixed.inset-0") as HTMLElement;
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("clicking inside the panel does NOT close the dialog", () => {
    seedTrack(ambiguousTrack([candidate()]));
    const onClose = vi.fn();
    render(<AmbiguousMatchDialog trackId="t1" onClose={onClose} />);
    // The dialog heading is inside the panel — a click there must not
    // bubble to the backdrop's onClose.
    fireEvent.click(screen.getByText("Pick a Spotify version"));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("auto-searches on mount when a candidate-less track has query fields", async () => {
    // Round-tripped imports drop the candidate array; the dialog fires one
    // search on mount so the user lands on a populated picker.
    seedTrack({
      id: "t1",
      source: { kind: "text", rawLine: "Radiohead - Nude" },
      title: "Nude",
      artist: "Radiohead",
      enrichment: { status: "idle" },
      spotify: { status: "missing" },
    } as unknown as Track);
    render(<AmbiguousMatchDialog trackId="t1" onClose={() => {}} />);
    await waitFor(() =>
      expect(searchSpotifyCandidatesByFields).toHaveBeenCalledTimes(1),
    );
  });
});
