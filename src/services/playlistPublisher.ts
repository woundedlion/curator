import type {
  PlaylistPushProgress,
} from "../spotify/playlists";
import {
  createPlaylist,
  pushTracksToPlaylist,
  replaceAndPushTracks,
} from "../spotify/playlists";
import { usePlaylistStore } from "../store/playlistStore";
import { useUiStore } from "../store/uiStore";

export type PublishMode =
  | { kind: "create" }
  | { kind: "update"; playlistId: string };

export type PublishResult = {
  playlistId: string;
  playlistUrl: string;
  progress: PlaylistPushProgress;
};

// Publish with no pushable URIs. Update-mode (Replace) would clear an
// existing Spotify playlist; create-mode would silently litter the user's
// account with empty playlists. In both cases surfacing the gap loudly
// is more useful than the silent "success" the API would otherwise give.
export class EmptyReplaceError extends Error {
  constructor() {
    super("Draft has no pushable tracks");
    this.name = "EmptyReplaceError";
  }
}

type DraftSnapshot = Pick<
  ReturnType<typeof usePlaylistStore.getState>,
  "playlist" | "tracksById"
>;

function collectPushableUris(state: DraftSnapshot): string[] {
  const hideUnmatched = state.playlist.hideUnmatched;
  const uris: string[] = [];
  for (const id of state.playlist.trackIds) {
    const track = state.tracksById[id];
    if (!track) continue;
    const match = track.spotify;
    const eligible = hideUnmatched
      ? match.status === "matched"
      : match.status === "matched" || match.status === "ambiguous";
    if (!eligible) continue;
    // REQUIRED for the type checker, not redundant: `eligible` is a plain
    // boolean derived from match.status, so `if (!eligible) continue` does
    // NOT narrow the `match` union. Without this explicit status check the
    // `.uri` access below is a type error (idle/pending/failed arms have no
    // `uri`). Both surviving arms carry `uri` — required on "matched",
    // optional on "ambiguous" — so the truthiness guard handles the latter.
    if (match.status !== "matched" && match.status !== "ambiguous") continue;
    if (match.uri) uris.push(match.uri);
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
  // Bracket the whole publish in the global busy counter like every other
  // orchestrator entry point (reenrichAll, reenrichTrack, the picker's
  // post-pick enrichment). A publish is a multi-second, rate-limited round
  // trip (create + paged track pushes); without this the global spinner
  // never engages and the UI looks idle mid-publish. withBusy returns the
  // callback's value, so the function's return contract is unchanged — an
  // EmptyReplaceError thrown inside still propagates out (withBusy
  // decrements in a finally regardless of throw).
  return useUiStore.getState().withBusy(async () => {
    // Read the draft once so the pushable URIs and the playlist metadata
    // come from the same snapshot — a store mutation between two getState()
    // reads (e.g. the user edits the name as publish kicks off) could
    // otherwise publish URIs from snapshot A with metadata from snapshot B.
    const state = usePlaylistStore.getState();
    const uris = collectPushableUris(state);
    const draft = state.playlist;

    // Refuse both create and update when there's nothing to push. The
    // alternative for create is a Spotify playlist that exists but has no
    // tracks — the user almost certainly intended the publish action as a
    // commit of *content*, not a metadata-only operation.
    if (uris.length === 0) throw new EmptyReplaceError();

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

    const created = await createPlaylist(
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
  });
}
