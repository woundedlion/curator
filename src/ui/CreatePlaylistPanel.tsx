import { useMemo, useState } from "react";
import { usePlaylistStore } from "../store/playlistStore";
import { useSettingsStore } from "../store/settingsStore";
import { useSpotifyStore } from "../store/spotifyStore";
import { useUiStore } from "../store/uiStore";
import { findPlaylistsByName } from "../spotify/playlists";
import { publishPlaylist } from "../services/playlistPublisher";
import { NameCollisionDialog } from "./NameCollisionDialog";
import type { SpotifyPlaylistSummary } from "../types";

function hasInFlightWork(): boolean {
  const state = usePlaylistStore.getState();
  for (const id of state.playlist.trackIds) {
    const track = state.tracksById[id];
    if (track?.enrichment.status === "pending") return true;
    if (track?.spotify.status === "pending") return true;
  }
  return false;
}

export function CreatePlaylistPanel() {
  const playlist = usePlaylistStore((state) => state.playlist);
  const setMeta = usePlaylistStore((state) => state.setPlaylistMeta);
  const clientId = useSettingsStore((state) => state.settings.spotifyClientId);
  const connected = useSpotifyStore((state) => state.connected);
  const user = useSpotifyStore((state) => state.user);
  const spotifyPlaylists = useSpotifyStore((state) => state.playlists);
  const pushToast = useUiStore((state) => state.pushToast);

  const [publishing, setPublishing] = useState(false);
  const [collision, setCollision] = useState<SpotifyPlaylistSummary[] | null>(
    null,
  );
  const [progressLabel, setProgressLabel] = useState<string>("");

  const inFlightWork = hasInFlightWork();
  const disabledReason = useMemo(() => {
    if (!connected) return "Connect to Spotify first";
    if (!playlist.name.trim()) return "Name the playlist first";
    if (inFlightWork) return "Wait for enrichment/search to finish";
    return null;
  }, [connected, playlist.name, inFlightWork]);

  async function publish(mode: "create" | { update: string }) {
    if (!clientId) return;
    setPublishing(true);
    try {
      const result = await publishPlaylist(
        clientId,
        typeof mode === "string"
          ? { kind: "create" }
          : { kind: "update", playlistId: mode.update },
        (progress) =>
          setProgressLabel(`${progress.added}/${progress.total} added`),
      );
      pushToast({
        kind: "success",
        message: "Playlist created on Spotify",
        href: result.playlistUrl,
      });
      void useSpotifyStore.getState().loadPlaylists(clientId);
    } catch (error) {
      console.error("publishPlaylist failed", error);
      pushToast({ kind: "error", message: "Publish failed" });
    } finally {
      setPublishing(false);
      setProgressLabel("");
      setCollision(null);
    }
  }

  function start() {
    if (!user) return;
    const matches = findPlaylistsByName(
      spotifyPlaylists,
      user.id,
      playlist.name,
    );
    if (matches.length === 0) {
      void publish("create");
      return;
    }
    setCollision(matches);
  }

  return (
    <div className="flex flex-col gap-2 border-t border-neutral-800 px-4 py-3">
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={playlist.name}
          onChange={(e) => setMeta({ name: e.target.value })}
          placeholder="Playlist name"
          className="flex-1 rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-sm"
        />
        <label className="flex items-center gap-1 text-xs">
          <input
            type="checkbox"
            checked={playlist.public}
            onChange={(e) => setMeta({ public: e.target.checked })}
          />
          Public
        </label>
        <label className="flex items-center gap-1 text-xs">
          <input
            type="checkbox"
            checked={playlist.collaborative}
            onChange={(e) => setMeta({ collaborative: e.target.checked })}
          />
          Collaborative
        </label>
        <button
          type="button"
          disabled={Boolean(disabledReason) || publishing}
          title={disabledReason ?? "Create Playlist"}
          onClick={start}
          className="rounded bg-matched px-3 py-1 text-sm font-semibold text-black hover:opacity-90 disabled:opacity-40"
        >
          {publishing ? progressLabel || "Working…" : "Create Playlist"}
        </button>
      </div>
      <textarea
        value={playlist.description ?? ""}
        onChange={(e) => setMeta({ description: e.target.value })}
        placeholder="Description (optional)"
        rows={1}
        className="rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-sm"
      />

      {collision && (
        <NameCollisionDialog
          candidateName={playlist.name}
          matches={collision}
          onReplace={(playlistId) => void publish({ update: playlistId })}
          onCancel={() => setCollision(null)}
        />
      )}
    </div>
  );
}
