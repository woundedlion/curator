import { useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { usePlaylistStore } from "../store/playlistStore";
import { useSettingsStore } from "../store/settingsStore";
import { useSpotifyStore } from "../store/spotifyStore";
import { useUiStore } from "../store/uiStore";
import {
  SpotifyAuthExpiredError,
  SpotifyForbiddenError,
  SpotifyRateLimitError,
} from "../spotify/apiClient";
import { exportActivePlaylist } from "../services/playlistExporter";
import {
  EmptyReplaceError,
  publishPlaylist,
} from "../services/playlistPublisher";
import { CloudUploadIcon, DownloadIcon } from "./icons";
import { IconButton } from "./IconButton";
import { NameCollisionDialog } from "./NameCollisionDialog";
import type { SpotifyPlaylistSummary } from "../types";

// 403s on /me/playlists with the stock "Forbidden" body almost always
// mean the user account isn't in the Spotify Dashboard app's User
// Management list. Insufficient-scope 403s say "Insufficient client
// scope" in the body and bootstrap already catches scope mismatches
// proactively, so by the time we reach here scopes are fine.
function describeForbiddenPublish(error: SpotifyForbiddenError): string {
  if (error.path === "/me/playlists") {
    return (
      "Spotify refused to create the playlist (403). " +
      "Verify your account is in your Spotify Dashboard app's User Management list " +
      "and that the app isn't restricted to Extended Quota endpoints only. " +
      "Full request/response details are in the console."
    );
  }
  return `Spotify denied the request (403): ${error.message}`;
}

function describePublishError(error: unknown): string {
  if (error instanceof EmptyReplaceError) {
    return "Draft has no Spotify-matched tracks — refusing to publish an empty playlist";
  }
  if (error instanceof SpotifyAuthExpiredError) {
    return "Spotify session expired — reconnect in Settings, then try again";
  }
  if (error instanceof SpotifyForbiddenError) {
    return describeForbiddenPublish(error);
  }
  if (error instanceof SpotifyRateLimitError) {
    return "Spotify rate-limited the publish — wait a minute, then retry";
  }
  if (error instanceof Error) {
    return `Publish failed: ${error.message}`;
  }
  return "Publish failed (see console for details)";
}

export function CreatePlaylistPanel() {
  const playlist = usePlaylistStore((state) => state.playlist);
  const setMeta = usePlaylistStore((state) => state.setPlaylistMeta);
  const trackCount = usePlaylistStore((state) => state.playlist.trackIds.length);
  const clientId = useSettingsStore((state) => state.settings.spotifyClientId);
  const connected = useSpotifyStore((state) => state.connected);
  const user = useSpotifyStore((state) => state.user);
  const spotifyPlaylists = useSpotifyStore((state) => state.playlists);
  const pushToast = useUiStore((state) => state.pushToast);

  // Single-pass derivation of both publish-gate signals. Previously
  // these were two separate selectors that each scanned every track on
  // every store mutation; consolidating halves the work and lets
  // useShallow shortcut the re-render when neither value changed.
  //
  // What gates publish, and what deliberately does NOT:
  //   - Spotify search still in flight (`pending`) DOES gate: the export
  //     publishes matched URIs, so a track whose match hasn't resolved
  //     yet would be silently omitted from the playlist.
  //   - An unresolved ambiguous row DOES gate: it demands a user pick
  //     before publish — silently dropping it produces a partial playlist
  //     the user didn't authorize.
  //   - MusicBrainz enrichment status does NOT gate. Enrichment only adds
  //     metadata (recording ids, cover art) and is irrelevant to the
  //     Spotify export, which needs only the matched URIs. Blocking
  //     publish until enrichment finished forced users to wait on
  //     background work that doesn't affect the result at all.
  const { spotifySearchInFlight, unresolvedAmbiguousCount } = usePlaylistStore(
    useShallow((state) => {
      let spotifySearchInFlight = false;
      let unresolvedAmbiguousCount = 0;
      for (const id of state.playlist.trackIds) {
        const track = state.tracksById[id];
        if (!track) continue;
        if (track.spotify.status === "pending") {
          spotifySearchInFlight = true;
        }
        if (track.spotify.status === "ambiguous" && !track.spotify.uri) {
          unresolvedAmbiguousCount++;
        }
      }
      return { spotifySearchInFlight, unresolvedAmbiguousCount };
    }),
  );

  const [publishing, setPublishing] = useState(false);
  const [collision, setCollision] = useState<SpotifyPlaylistSummary[] | null>(
    null,
  );
  const [progressLabel, setProgressLabel] = useState<string>("");
  const publishDisabledReason = useMemo(() => {
    if (!connected) return "Connect to Spotify first";
    if (!playlist.name.trim()) return "Name the playlist first";
    if (spotifySearchInFlight) return "Wait for Spotify search to finish";
    if (unresolvedAmbiguousCount > 0) {
      return `Pick a Spotify match for ${unresolvedAmbiguousCount} ambiguous track${unresolvedAmbiguousCount === 1 ? "" : "s"}`;
    }
    if (trackCount === 0) return "Add tracks before publishing";
    return null;
  }, [connected, playlist.name, spotifySearchInFlight, unresolvedAmbiguousCount, trackCount]);

  async function publish(mode: "create" | { update: string }) {
    if (!clientId) return;
    const isCreate = typeof mode === "string";
    setPublishing(true);
    try {
      const result = await publishPlaylist(
        clientId,
        isCreate
          ? { kind: "create" }
          : { kind: "update", playlistId: mode.update },
        (progress) =>
          setProgressLabel(`${progress.added}/${progress.total} added`),
      );
      const { added, total, failedChunks } = result.progress;
      if (failedChunks.length > 0) {
        pushToast({
          kind: "error",
          message: `Published partially: ${added}/${total} tracks added — ${failedChunks.length} chunk${failedChunks.length === 1 ? "" : "s"} failed (retry to fill gaps)`,
          href: result.playlistUrl,
        });
      } else {
        pushToast({
          kind: "success",
          message: isCreate
            ? "Playlist created on Spotify"
            : "Playlist updated on Spotify",
          href: result.playlistUrl,
        });
      }
      void useSpotifyStore.getState().loadPlaylists(clientId);
    } catch (error) {
      console.error("publishPlaylist failed", error);
      pushToast({
        kind: "error",
        message: describePublishError(error),
      });
    } finally {
      setPublishing(false);
      setProgressLabel("");
      setCollision(null);
    }
  }

  function start() {
    if (!user) return;
    const targetName = playlist.name.trim().toLowerCase();
    const matches = spotifyPlaylists.filter(
      (p) =>
        p.ownerId === user.id &&
        p.name.trim().toLowerCase() === targetName,
    );
    if (matches.length === 0) {
      void publish("create");
      return;
    }
    setCollision(matches);
  }

  const exportDisabledReason =
    trackCount === 0 ? "Nothing to export" : null;
  const publishLabel =
    publishing && progressLabel
      ? `Publishing — ${progressLabel}`
      : publishDisabledReason ?? "Create / update on Spotify";

  return (
    <div className="flex flex-col gap-2 border-t border-neutral-800 px-4 py-3">
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={playlist.name}
          onChange={(e) => setMeta({ name: e.target.value })}
          placeholder="Playlist name"
          aria-label="Playlist name"
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
        {publishing && progressLabel && (
          <span
            className="text-xs text-neutral-400 tabular-nums"
            aria-live="polite"
          >
            {progressLabel}
          </span>
        )}
        <IconButton
          label={exportDisabledReason ?? "Export playlist to file"}
          icon={<DownloadIcon />}
          onClick={exportActivePlaylist}
          disabled={Boolean(exportDisabledReason)}
        />
        <IconButton
          label={publishLabel}
          icon={<CloudUploadIcon />}
          onClick={start}
          disabled={Boolean(publishDisabledReason) || publishing}
        />
      </div>
      <textarea
        value={playlist.description ?? ""}
        onChange={(e) => setMeta({ description: e.target.value })}
        placeholder="Description (optional)"
        aria-label="Playlist description"
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
