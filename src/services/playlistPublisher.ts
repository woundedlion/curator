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

function collectPushableUris(): string[] {
  const state = usePlaylistStore.getState();
  const hideUnmatched = state.playlist.hideUnmatched;
  return state.playlist.trackIds
    .map((id) => state.tracksById[id])
    .filter((track) =>
      hideUnmatched
        ? track.spotify.status === "matched"
        : track.spotify.status === "matched" ||
          track.spotify.status === "ambiguous",
    )
    .map((track) => track.spotify.uri)
    .filter((uri): uri is string => Boolean(uri));
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
