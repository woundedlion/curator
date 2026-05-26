import type {
  PlaylistPushProgress,
} from "../spotify/playlists";
import {
  createPlaylist,
  pushTracksToPlaylist,
  replaceAndPushTracks,
} from "../spotify/playlists";
import { usePlaylistStore } from "../store/playlistStore";
import { useSpotifyStore } from "../store/spotifyStore";

export type PublishMode =
  | { kind: "create" }
  | { kind: "update"; playlistId: string };

export type PublishResult = {
  playlistId: string;
  playlistUrl: string;
  progress: PlaylistPushProgress;
};

// Update-mode (Replace) with no pushable URIs would issue a PUT /items
// with an empty body, which Spotify treats as "clear this playlist." The
// user almost never wants that — they wanted to publish a draft and the
// draft happened to be empty (every row unmatched + hideUnmatched=true).
// Surfacing it explicitly is the only way to avoid silent data loss
// against a real Spotify playlist.
export class EmptyReplaceError extends Error {
  constructor() {
    super("Draft has no pushable tracks");
    this.name = "EmptyReplaceError";
  }
}

function collectPushableUris(): string[] {
  const state = usePlaylistStore.getState();
  const hideUnmatched = state.playlist.hideUnmatched;
  const uris: string[] = [];
  for (const id of state.playlist.trackIds) {
    const track = state.tracksById[id];
    if (!track) continue;
    const status = track.spotify.status;
    const eligible = hideUnmatched
      ? status === "matched"
      : status === "matched" || status === "ambiguous";
    if (!eligible) continue;
    const uri = track.spotify.uri;
    if (uri) uris.push(uri);
  }
  return uris;
}

function playlistWebUrl(playlistId: string): string {
  return `https://open.spotify.com/playlist/${playlistId}`;
}

export async function publishPlaylist(
  clientId: string,
  mode: PublishMode,
  onProgress?: (progress: PlaylistPushProgress) => void,
): Promise<PublishResult> {
  const uris = collectPushableUris();
  const draft = usePlaylistStore.getState().playlist;

  if (mode.kind === "update") {
    if (uris.length === 0) throw new EmptyReplaceError();
    const progress = await replaceAndPushTracks(
      mode.playlistId,
      uris,
      clientId,
      { onProgress },
    );
    return {
      playlistId: mode.playlistId,
      playlistUrl: playlistWebUrl(mode.playlistId),
      progress,
    };
  }

  const user = useSpotifyStore.getState().user;
  if (!user) throw new Error("Spotify user is not loaded");

  const created = await createPlaylist(
    user.id,
    {
      name: draft.name,
      description: draft.description,
      public: draft.public,
      collaborative: draft.collaborative,
    },
    clientId,
  );
  const progress = await pushTracksToPlaylist(created.id, uris, clientId, {
    onProgress,
  });
  return {
    playlistId: created.id,
    playlistUrl: playlistWebUrl(created.id),
    progress,
  };
}
