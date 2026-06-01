import { useMemo } from "react";
import { useSpotifyStore } from "../store/spotifyStore";
import { useSettingsStore } from "../store/settingsStore";
import { importPlaylistById } from "../services/ingestController";
import { IconButton } from "./IconButton";
import { RefreshIcon } from "./icons";
import { Spinner } from "./Spinner";
import { setPlaylistDragPayload } from "./dragData";

export function Sidebar() {
  const clientId = useSettingsStore((state) => state.settings.spotifyClientId);
  const playlists = useSpotifyStore((state) => state.playlists);
  const loading = useSpotifyStore((state) => state.loadingPlaylists);
  const connected = useSpotifyStore((state) => state.connected);
  const loadPlaylists = useSpotifyStore((state) => state.loadPlaylists);

  const sortedPlaylists = useMemo(
    () =>
      [...playlists].sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
      ),
    [playlists],
  );

  function refresh() {
    if (!clientId) return;
    // Wired straight to a button onClick — swallow the rejection here so a
    // failed load surfaces in the console instead of becoming an unhandled
    // promise rejection (the appendPlaylist path already does this).
    loadPlaylists(clientId).catch((error) => {
      console.error("loadPlaylists (refresh) crashed", error);
    });
  }

  function buildDragHandler(playlistId: string) {
    return (event: React.DragEvent<HTMLLIElement>) => {
      setPlaylistDragPayload(event.dataTransfer, playlistId);
    };
  }

  // Keyboard-accessible alternative to drag-and-drop: HTML5 DnD can't be
  // driven from the keyboard, so the per-row "Append" button is the only
  // way a keyboard-only user can add a playlist to the draft. Both paths
  // funnel through the same importPlaylistById action.
  function appendPlaylist(playlistId: string) {
    importPlaylistById(playlistId).catch((error) => {
      console.error("importPlaylistById crashed", error);
    });
  }

  return (
    <aside
      className="flex w-64 shrink-0 flex-col border-r border-neutral-800 bg-neutral-950 text-sm"
      aria-label="Spotify playlists"
    >
      <div className="flex items-center justify-between border-b border-neutral-800 px-3 py-2">
        <h2 className="font-semibold">Spotify playlists</h2>
        <IconButton
          label="Refresh playlists"
          icon={<RefreshIcon />}
          onClick={refresh}
          disabled={!connected || loading}
        />
      </div>

      {!connected ? (
        <p className="px-3 py-4 text-xs text-neutral-400">
          Not connected. Set your Spotify Client ID in Settings.
        </p>
      ) : loading ? (
        <div className="flex flex-1 items-center justify-center py-8">
          <Spinner size="md" label="Refreshing playlists" />
        </div>
      ) : (
        <>
          <p className="px-3 py-2 text-xs text-neutral-500">
            Drag a playlist onto the draft, or use Append, to add its tracks.
          </p>
          <ul className="flex-1 overflow-auto">
            {sortedPlaylists.map((playlist) => (
              <li
                key={playlist.id}
                draggable
                // The whole row is a native HTML5 drag source (the visible
                // grab cursor sits on an inner div), which isn't otherwise
                // exposed to assistive tech. Announce it as draggable so
                // screen-reader users know the interaction exists.
                aria-roledescription="draggable playlist"
                onDragStart={buildDragHandler(playlist.id)}
                className="flex items-center gap-2 border-b border-neutral-900 px-3 py-2 hover:bg-neutral-900"
              >
                <div className="min-w-0 flex-1 cursor-grab active:cursor-grabbing">
                  <div className="truncate font-medium">{playlist.name}</div>
                  <div className="text-xs text-neutral-400">
                    {playlist.trackCount === undefined
                      ? "? tracks"
                      : `${playlist.trackCount} tracks`}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => appendPlaylist(playlist.id)}
                  aria-label={`Append ${playlist.name} to the draft`}
                  title="Append this playlist's tracks to the draft"
                  className="shrink-0 rounded border border-neutral-700 px-2 py-1 text-xs text-neutral-300 hover:bg-neutral-800"
                >
                  + Append
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </aside>
  );
}
