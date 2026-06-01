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

  it("after unmatch, the candidate list stays pinned (rapid reopen still shows candidates)", () => {
    // Toggling off a match flips the row to "missing" (no candidates of its
    // own). The dialog pins a SNAPSHOT of the candidate list so it survives
    // that store transition — the user can still see and re-pick versions.
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
    // unpickSpotifyMatch is mocked, so simulate its store effect: flip the
    // row to "missing" (which carries no candidates), as the real one does.
    vi.mocked(unpickSpotifyMatch).mockImplementationOnce((id: string) => {
      usePlaylistStore.setState({
        tracksById: {
          ...usePlaylistStore.getState().tracksById,
          [id]: { ...matched, spotify: { status: "missing" } } as Track,
        },
      });
    });
    render(<AmbiguousMatchDialog trackId="t1" onClose={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: /OK Computer/ }));
    expect(unpickSpotifyMatch).toHaveBeenCalledTimes(1);
    // Both versions are still listed even though the track is now "missing".
    expect(screen.getByRole("button", { name: /OK Computer/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /OKNOTOK/ })).toBeTruthy();
  });

  it("the footer button is 'Done' (affirmative close) and closes the dialog", () => {
    // Bug fix: picks/unpicks commit to the store immediately, so the footer
    // is an affirmative "Done" — a "Cancel" label wrongly implied closing
    // would discard an unpick. Clicking it closes; the store change persists.
    seedTrack(ambiguousTrack([candidate()]));
    const onClose = vi.fn();
    render(<AmbiguousMatchDialog trackId="t1" onClose={onClose} />);
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("dedupes candidates that share a uri (no duplicate React keys)", () => {
    // A re-search merge can occasionally surface the same Spotify track
    // twice; the render must collapse them to a single row.
    seedTrack(
      ambiguousTrack([
        candidate(),
        candidate(), // same uri as the first
        candidate({ uri: "spotify:track:bbb", id: "bbb", album: "OKNOTOK" }),
      ]),
    );
    render(<AmbiguousMatchDialog trackId="t1" onClose={() => {}} />);
    // The duplicate "OK Computer" row collapses to one selectable button.
    expect(screen.getAllByRole("button", { name: /OK Computer/ })).toHaveLength(
      1,
    );
    expect(screen.getByRole("button", { name: /OKNOTOK/ })).toBeTruthy();
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

  it("typing in the fields while a search is in flight keeps the dialog mounted", () => {
    seedTrack(ambiguousTrack([candidate()]));
    // Search never resolves → `searching` stays true (the spinner phase
    // the user is typing during).
    vi.mocked(searchSpotifyCandidatesByFields).mockImplementationOnce(
      () => new Promise<SpotifyCandidate[]>(() => {}),
    );
    render(<AmbiguousMatchDialog trackId="t1" onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    const titleInput = screen.getByPlaceholderText("Title");
    const artistInput = screen.getByPlaceholderText("Artist");
    fireEvent.change(titleInput, { target: { value: "Karma Police (live)" } });
    fireEvent.change(artistInput, { target: { value: "Radiohead!" } });
    // The dialog must still be mounted after typing mid-search.
    expect(screen.getByText("Pick a Spotify version")).toBeTruthy();
    expect((titleInput as HTMLInputElement).value).toBe("Karma Police (live)");
  });

  it("clicking the backdrop closes the dialog (== onClose)", () => {
    seedTrack(ambiguousTrack([candidate()]));
    const onClose = vi.fn();
    const { container } = render(
      <AmbiguousMatchDialog trackId="t1" onClose={onClose} />,
    );
    // The backdrop is the outermost fixed-inset overlay; a genuine click on
    // it (press AND release on the backdrop) cancels. A real click is always
    // preceded by a mousedown on the same element, so simulate both.
    const backdrop = container.querySelector(".fixed.inset-0") as HTMLElement;
    fireEvent.mouseDown(backdrop);
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("REGRESSION: selecting text in a field and releasing the drag on the backdrop does NOT close", () => {
    // The reported bug: press inside an input to select text, drag outside
    // the panel, release — the browser synthesizes a click whose target is
    // the backdrop, which used to dismiss the dialog mid-edit. The press
    // STARTED in the panel, so it must not count as a backdrop dismiss.
    seedTrack(ambiguousTrack([candidate()]));
    const onClose = vi.fn();
    const { container } = render(
      <AmbiguousMatchDialog trackId="t1" onClose={onClose} />,
    );
    const titleInput = screen.getByPlaceholderText("Title");
    const backdrop = container.querySelector(".fixed.inset-0") as HTMLElement;
    // mousedown on the input (inside the panel), then the synthesized click
    // lands on the backdrop (common ancestor of press + outside release).
    fireEvent.mouseDown(titleInput);
    fireEvent.click(backdrop);
    expect(onClose).not.toHaveBeenCalled();
    // Dialog is still mounted.
    expect(screen.getByText("Pick a Spotify version")).toBeTruthy();
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

describe("AmbiguousMatchDialog — disambiguation workflow navigation", () => {
  function workflow(over: Partial<Parameters<typeof AmbiguousMatchDialog>[0]["workflow"] & object> = {}) {
    return {
      position: 2,
      total: 5,
      onSkip: vi.fn(),
      onBack: vi.fn(),
      onResolved: vi.fn(),
      ...over,
    };
  }

  it("Right arrow skips (advances) and Left arrow goes back", () => {
    seedTrack(ambiguousTrack([candidate()]));
    const wf = workflow();
    render(
      <AmbiguousMatchDialog trackId="t1" onClose={() => {}} workflow={wf} />,
    );
    const dialog = screen.getByRole("dialog");
    fireEvent.keyDown(dialog, { key: "ArrowRight" });
    expect(wf.onSkip).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(dialog, { key: "ArrowLeft" });
    expect(wf.onBack).toHaveBeenCalledTimes(1);
  });

  it("Left arrow is a no-op at the first work item", () => {
    seedTrack(ambiguousTrack([candidate()]));
    const wf = workflow({ position: 1 });
    render(
      <AmbiguousMatchDialog trackId="t1" onClose={() => {}} workflow={wf} />,
    );
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "ArrowLeft" });
    expect(wf.onBack).not.toHaveBeenCalled();
  });

  it("arrow keys are ignored while the caret is in a search input", () => {
    seedTrack(ambiguousTrack([candidate()]));
    const wf = workflow();
    render(
      <AmbiguousMatchDialog trackId="t1" onClose={() => {}} workflow={wf} />,
    );
    fireEvent.keyDown(screen.getByPlaceholderText("Title"), {
      key: "ArrowRight",
    });
    fireEvent.keyDown(screen.getByPlaceholderText("Artist"), {
      key: "ArrowLeft",
    });
    expect(wf.onSkip).not.toHaveBeenCalled();
    expect(wf.onBack).not.toHaveBeenCalled();
  });

  it("the Back button is disabled at the first item and enabled later", () => {
    seedTrack(ambiguousTrack([candidate()]));
    const { rerender } = render(
      <AmbiguousMatchDialog
        trackId="t1"
        onClose={() => {}}
        workflow={workflow({ position: 1 })}
      />,
    );
    expect(
      (screen.getByRole("button", { name: "Back" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    rerender(
      <AmbiguousMatchDialog
        trackId="t1"
        onClose={() => {}}
        workflow={workflow({ position: 3 })}
      />,
    );
    expect(
      (screen.getByRole("button", { name: "Back" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });
});
