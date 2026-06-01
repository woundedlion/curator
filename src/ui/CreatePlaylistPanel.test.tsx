// @vitest-environment happy-dom
//
// CreatePlaylistPanel previously had no tests. Covers the publish gating
// (disabled reasons surfaced as the button's accessible name), the
// name-collision branch (Create with a same-named owned playlist opens the
// NameCollisionDialog instead of publishing), the Replace path, and the
// export-disabled-when-empty gate. publishPlaylist / exportActivePlaylist
// are mocked (real network/file side effects); everything else runs against
// the real Zustand stores.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type * as PublisherModule from "../services/playlistPublisher";

vi.mock("../services/playlistPublisher", async () => {
  const actual = await vi.importActual<typeof PublisherModule>(
    "../services/playlistPublisher",
  );
  return { ...actual, publishPlaylist: vi.fn() };
});
vi.mock("../services/playlistExporter", () => ({
  exportActivePlaylist: vi.fn(),
}));

import { CreatePlaylistPanel } from "./CreatePlaylistPanel";
import { publishPlaylist } from "../services/playlistPublisher";
import { exportActivePlaylist } from "../services/playlistExporter";
import { usePlaylistStore } from "../store/playlistStore";
import { useSettingsStore } from "../store/settingsStore";
import { useSpotifyStore } from "../store/spotifyStore";
import type { SpotifyPlaylistSummary, Track } from "../types";

function matchedTrack(id: string): Track {
  return {
    id,
    source: { kind: "text", rawLine: id },
    title: id,
    artist: "A",
    enrichment: { status: "idle" },
    spotify: { status: "matched", uri: `spotify:track:${id}`, candidates: [], score: 1 },
  } as unknown as Track;
}

function ambiguousTrack(id: string): Track {
  return {
    id,
    source: { kind: "text", rawLine: id },
    title: id,
    artist: "A",
    enrichment: { status: "idle" },
    spotify: { status: "ambiguous", candidates: [], score: 0.5 },
  } as unknown as Track;
}

function seed(tracks: Track[], name = "My Mix"): void {
  const tracksById: Record<string, Track> = {};
  for (const t of tracks) tracksById[t.id] = t;
  usePlaylistStore.setState({
    tracksById,
    playlist: {
      ...usePlaylistStore.getState().playlist,
      name,
      trackIds: tracks.map((t) => t.id),
    },
  });
}

function setSpotify(opts: {
  connected: boolean;
  playlists?: SpotifyPlaylistSummary[];
}): void {
  useSpotifyStore.setState({
    connected: opts.connected,
    user: opts.connected ? { id: "me", displayName: "Me" } : null,
    playlists: opts.playlists ?? [],
    loadPlaylists: vi.fn(async () => undefined),
  });
}

beforeEach(() => {
  usePlaylistStore.setState({
    tracksById: {},
    playlist: {
      ...usePlaylistStore.getState().playlist,
      name: "My Mix",
      description: "",
      public: false,
      collaborative: false,
      trackIds: [],
    },
  });
  useSettingsStore.setState({
    settings: { ...useSettingsStore.getState().settings, spotifyClientId: "cid" },
  });
  setSpotify({ connected: false });
  vi.mocked(publishPlaylist).mockResolvedValue({
    playlistId: "pl-new",
    playlistUrl: "https://open.spotify.com/playlist/pl-new",
    progress: { added: 1, total: 1, failedChunks: [] },
  } as Awaited<ReturnType<typeof publishPlaylist>>);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("CreatePlaylistPanel — publish gating", () => {
  it("surfaces 'Connect to Spotify first' and disables publish when disconnected", () => {
    seed([matchedTrack("t1")]);
    setSpotify({ connected: false });
    render(<CreatePlaylistPanel />);
    const btn = screen.getByRole("button", {
      name: "Connect to Spotify first",
    }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it("disables publish and explains when an ambiguous track is unresolved", () => {
    seed([matchedTrack("t1"), ambiguousTrack("t2")]);
    setSpotify({ connected: true });
    render(<CreatePlaylistPanel />);
    const btn = screen.getByRole("button", {
      name: "Pick a Spotify match for 1 ambiguous track",
    }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it("enables publish when connected, named, and all tracks resolved", () => {
    seed([matchedTrack("t1")]);
    setSpotify({ connected: true });
    render(<CreatePlaylistPanel />);
    const btn = screen.getByRole("button", {
      name: "Create / update on Spotify",
    }) as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
  });

  it("does NOT block publish while MusicBrainz enrichment is still pending", () => {
    // Enrichment only adds metadata (recording ids, cover art) and is
    // irrelevant to the Spotify export, which needs only the matched URI.
    // A Spotify-matched track whose MB enrichment is still in flight must
    // remain publishable — waiting on enrichment was the reported bug.
    const enrichingMatched = {
      id: "t1",
      source: { kind: "text", rawLine: "t1" },
      title: "t1",
      artist: "A",
      enrichment: { status: "pending" },
      spotify: { status: "matched", uri: "spotify:track:t1", candidates: [], score: 1 },
    } as unknown as Track;
    seed([enrichingMatched]);
    setSpotify({ connected: true });
    render(<CreatePlaylistPanel />);
    const btn = screen.getByRole("button", {
      name: "Create / update on Spotify",
    }) as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
  });

  it("still blocks publish while a Spotify search is in flight (URI not resolved yet)", () => {
    // Spotify 'pending' DOES gate: publishing now would silently omit a
    // track whose match hasn't landed. (This is the one in-flight state
    // that legitimately blocks — distinct from enrichment, above.)
    const searching = {
      id: "t1",
      source: { kind: "text", rawLine: "t1" },
      title: "t1",
      artist: "A",
      enrichment: { status: "idle" },
      spotify: { status: "pending" },
    } as unknown as Track;
    seed([searching]);
    setSpotify({ connected: true });
    render(<CreatePlaylistPanel />);
    const btn = screen.getByRole("button", {
      name: "Wait for Spotify search to finish",
    }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });
});

describe("CreatePlaylistPanel — publish flow", () => {
  it("Create with no name collision publishes in 'create' mode", async () => {
    seed([matchedTrack("t1")], "Fresh Name");
    setSpotify({ connected: true, playlists: [] });
    render(<CreatePlaylistPanel />);
    fireEvent.click(
      screen.getByRole("button", { name: "Create / update on Spotify" }),
    );
    await waitFor(() => expect(publishPlaylist).toHaveBeenCalledTimes(1));
    expect(vi.mocked(publishPlaylist).mock.calls[0]![1]).toEqual({
      kind: "create",
    });
  });

  it("Create with a same-named owned playlist opens the collision dialog instead of publishing", () => {
    seed([matchedTrack("t1")], "My Mix");
    setSpotify({
      connected: true,
      playlists: [{ id: "pl-1", name: "My Mix", ownerId: "me", trackCount: 5 }],
    });
    render(<CreatePlaylistPanel />);
    fireEvent.click(
      screen.getByRole("button", { name: "Create / update on Spotify" }),
    );
    // No publish yet — the collision dialog is shown.
    expect(publishPlaylist).not.toHaveBeenCalled();
    expect(
      screen.getByRole("dialog", {
        name: "Existing playlist with the same name",
      }),
    ).toBeTruthy();
  });

  it("Replacing the collision publishes in 'update' mode against the chosen id", async () => {
    seed([matchedTrack("t1")], "My Mix");
    setSpotify({
      connected: true,
      playlists: [{ id: "pl-1", name: "My Mix", ownerId: "me", trackCount: 5 }],
    });
    render(<CreatePlaylistPanel />);
    fireEvent.click(
      screen.getByRole("button", { name: "Create / update on Spotify" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Replace existing" }));
    await waitFor(() => expect(publishPlaylist).toHaveBeenCalledTimes(1));
    expect(vi.mocked(publishPlaylist).mock.calls[0]![1]).toEqual({
      kind: "update",
      playlistId: "pl-1",
    });
  });

  it("ignores a same-named playlist owned by someone else (no collision)", async () => {
    seed([matchedTrack("t1")], "My Mix");
    setSpotify({
      connected: true,
      playlists: [
        { id: "pl-x", name: "My Mix", ownerId: "someone-else", trackCount: 5 },
      ],
    });
    render(<CreatePlaylistPanel />);
    fireEvent.click(
      screen.getByRole("button", { name: "Create / update on Spotify" }),
    );
    await waitFor(() => expect(publishPlaylist).toHaveBeenCalledTimes(1));
    expect(vi.mocked(publishPlaylist).mock.calls[0]![1]).toEqual({
      kind: "create",
    });
  });
});

describe("CreatePlaylistPanel — export + metadata", () => {
  it("disables export when there are no tracks", () => {
    seed([]);
    render(<CreatePlaylistPanel />);
    expect(
      (screen.getByRole("button", { name: "Nothing to export" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("export button triggers exportActivePlaylist when tracks exist", () => {
    seed([matchedTrack("t1")]);
    render(<CreatePlaylistPanel />);
    fireEvent.click(
      screen.getByRole("button", { name: "Export playlist to file" }),
    );
    expect(exportActivePlaylist).toHaveBeenCalledTimes(1);
  });

  it("editing the name writes through to the playlist store", () => {
    seed([matchedTrack("t1")]);
    render(<CreatePlaylistPanel />);
    fireEvent.change(screen.getByPlaceholderText("Playlist name"), {
      target: { value: "Renamed" },
    });
    expect(usePlaylistStore.getState().playlist.name).toBe("Renamed");
  });

  it("toggling Public/Collaborative writes through to the store", () => {
    seed([matchedTrack("t1")]);
    render(<CreatePlaylistPanel />);
    fireEvent.click(screen.getByLabelText("Public"));
    fireEvent.click(screen.getByLabelText("Collaborative"));
    expect(usePlaylistStore.getState().playlist.public).toBe(true);
    expect(usePlaylistStore.getState().playlist.collaborative).toBe(true);
  });
});
