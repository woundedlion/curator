import { useSpotifyStore } from "../store/spotifyStore";
import { useSettingsStore } from "../store/settingsStore";
import { IconButton } from "./IconButton";
import { Spinner } from "./Spinner";
import { setPlaylistDragPayload } from "./dragData";

export function Sidebar() {
  const clientId = useSettingsStore((state) => state.settings.spotifyClientId);
  const playlists = useSpotifyStore((state) => state.playlists);
  const loading = useSpotifyStore((state) => state.loadingPlaylists);
  const connected = useSpotifyStore((state) => state.connected);
  const loadPlaylists = useSpotifyStore((state) => state.loadPlaylists);

  async function refresh() {
    if (!clientId) return;
    await loadPlaylists(clientId);
  }

  function buildDragHandler(playlistId: string) {
    return (event: React.DragEvent<HTMLLIElement>) => {
      setPlaylistDragPayload(event.dataTransfer, playlistId);
    };
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
          icon="↻"
          onClick={refresh}
          disabled={!connected || loading}
          className="px-1 py-0 text-xs"
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
            Drag a playlist onto the draft to append its tracks.
          </p>
          <ul className="flex-1 overflow-auto">
            {playlists.map((playlist) => (
              <li
                key={playlist.id}
                draggable
                onDragStart={buildDragHandler(playlist.id)}
                className="cursor-grab border-b border-neutral-900 px-3 py-2 hover:bg-neutral-900 active:cursor-grabbing"
              >
                <div className="truncate font-medium">{playlist.name}</div>
                <div className="text-xs text-neutral-400">
                  {playlist.trackCount === undefined
                    ? "? tracks"
                    : `${playlist.trackCount} tracks`}
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </aside>
  );
}
