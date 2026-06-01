import { useCallback, useMemo, useState } from "react";
import { useSpotifyStore } from "../store/spotifyStore";
import { useSettingsStore } from "../store/settingsStore";
import { useUiStore } from "../store/uiStore";
import { importPlaylistById } from "../services/ingestController";
import { addCandidateTrack } from "../services/addTrackController";
import { fetchPlaylistCandidates } from "../spotify/playlists";
import { SpotifyForbiddenError } from "../spotify/apiClient";
import type { SpotifyCandidate } from "../types";
import { formatDuration } from "../util/duration";
import { IconButton } from "./IconButton";
import { ChevronRightIcon, PlusIcon, RefreshIcon } from "./icons";
import { Spinner } from "./Spinner";
import { setPlaylistDragPayload, setTrackDragPayload } from "./dragData";

// Lazy per-playlist track-list state for the expandable rows (DESIGN
// §4.7.3). Kept local to the Sidebar (not the global spotifyStore) because
// it's pure view state — the cache lives as long as the panel is mounted and
// a collapse/re-expand reuses it without a refetch.
type ExpandState = {
  loading: boolean;
  candidates: SpotifyCandidate[] | null;
  error: string | null;
};

export function Sidebar() {
  const clientId = useSettingsStore((state) => state.settings.spotifyClientId);
  const playlists = useSpotifyStore((state) => state.playlists);
  const loading = useSpotifyStore((state) => state.loadingPlaylists);
  const connected = useSpotifyStore((state) => state.connected);
  const loadPlaylists = useSpotifyStore((state) => state.loadPlaylists);
  const pushToast = useUiStore((state) => state.pushToast);

  // Which playlist rows are expanded, and the fetched tracks per id.
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [tracksByPlaylist, setTracksByPlaylist] = useState<
    Record<string, ExpandState>
  >({});

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
    return (event: React.DragEvent<HTMLDivElement>) => {
      setPlaylistDragPayload(event.dataTransfer, playlistId);
    };
  }

  // Keyboard-accessible alternative to drag-and-drop: HTML5 DnD can't be
  // driven from the keyboard, so the per-row Append button is the only way
  // a keyboard-only user can add a playlist to the draft. Both paths funnel
  // through the same importPlaylistById action.
  function appendPlaylist(playlistId: string) {
    importPlaylistById(playlistId).catch((error) => {
      console.error("importPlaylistById crashed", error);
    });
  }

  // Lazily fetch a playlist's tracks the first time it's expanded; reuse the
  // cached result on a later re-expand.
  const loadExpanded = useCallback(
    async (playlistId: string) => {
      if (!clientId) return;
      setTracksByPlaylist((prev) => ({
        ...prev,
        [playlistId]: { loading: true, candidates: null, error: null },
      }));
      try {
        const candidates = await fetchPlaylistCandidates(playlistId, clientId);
        setTracksByPlaylist((prev) => ({
          ...prev,
          [playlistId]: { loading: false, candidates, error: null },
        }));
      } catch (error) {
        console.error("fetchPlaylistCandidates crashed", error);
        const message =
          error instanceof SpotifyForbiddenError
            ? "Spotify denied access to this playlist (403)"
            : error instanceof Error
              ? error.message
              : "Couldn't load tracks";
        setTracksByPlaylist((prev) => ({
          ...prev,
          [playlistId]: { loading: false, candidates: null, error: message },
        }));
        pushToast({ kind: "error", message: `Couldn't load tracks: ${message}` });
      }
    },
    [clientId, pushToast],
  );

  function toggleExpand(playlistId: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(playlistId)) {
        next.delete(playlistId);
      } else {
        next.add(playlistId);
        // Fetch on first expand only (no cached result yet).
        if (!tracksByPlaylist[playlistId]) {
          void loadExpanded(playlistId);
        }
      }
      return next;
    });
  }

  function appendTrack(candidate: SpotifyCandidate) {
    addCandidateTrack(candidate);
    pushToast({
      kind: "success",
      message: `Added "${candidate.title}" to the draft`,
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
            Drag a playlist onto the draft, or use +, to add its tracks. Expand
            a playlist to add individual tracks.
          </p>
          <ul className="flex-1 overflow-auto">
            {sortedPlaylists.map((playlist) => {
              const isExpanded = expanded.has(playlist.id);
              const state = tracksByPlaylist[playlist.id];
              return (
                <li
                  key={playlist.id}
                  className="border-b border-neutral-900"
                >
                  <div
                    draggable
                    // The whole row is a native HTML5 drag source (the visible
                    // grab cursor sits on the title block), which isn't
                    // otherwise exposed to assistive tech. Announce it as
                    // draggable so screen-reader users know the interaction
                    // exists.
                    aria-roledescription="draggable playlist"
                    onDragStart={buildDragHandler(playlist.id)}
                    className="flex items-center gap-1 px-2 py-2 hover:bg-neutral-900"
                  >
                    <button
                      type="button"
                      onClick={() => toggleExpand(playlist.id)}
                      aria-expanded={isExpanded}
                      aria-label={
                        isExpanded
                          ? `Collapse ${playlist.name}`
                          : `Expand ${playlist.name} to browse its tracks`
                      }
                      title={isExpanded ? "Collapse" : "Expand to browse tracks"}
                      className="inline-flex h-6 w-6 shrink-0 items-center justify-center bg-transparent text-neutral-400 transition-opacity hover:opacity-80"
                    >
                      <ChevronRightIcon
                        className={isExpanded ? "rotate-90 transition-transform" : "transition-transform"}
                      />
                    </button>
                    <div className="min-w-0 flex-1 cursor-grab active:cursor-grabbing">
                      <div className="truncate font-medium">{playlist.name}</div>
                      <div className="text-xs text-neutral-400">
                        {playlist.trackCount === undefined
                          ? "? tracks"
                          : `${playlist.trackCount} tracks`}
                      </div>
                    </div>
                    <IconButton
                      label={`Append ${playlist.name} to the draft`}
                      icon={<PlusIcon />}
                      onClick={() => appendPlaylist(playlist.id)}
                    />
                  </div>

                  {isExpanded && (
                    <div className="bg-neutral-950 pb-1 pl-7 pr-2">
                      {state?.loading ? (
                        <div className="flex items-center gap-2 py-2 text-xs text-neutral-400">
                          <Spinner size="sm" label="Loading tracks" />
                          Loading tracks…
                        </div>
                      ) : state?.error ? (
                        <p className="py-2 text-xs text-ambiguous">
                          {state.error}
                        </p>
                      ) : state?.candidates && state.candidates.length > 0 ? (
                        <ul className="flex flex-col">
                          {state.candidates.map((candidate) => (
                            <li
                              key={candidate.uri}
                              draggable
                              aria-roledescription="draggable track"
                              onDragStart={(event) =>
                                setTrackDragPayload(event.dataTransfer, candidate)
                              }
                              className="flex items-center gap-1 rounded py-1 hover:bg-neutral-900"
                            >
                              <div className="min-w-0 flex-1 cursor-grab active:cursor-grabbing">
                                <div className="truncate text-xs font-medium">
                                  {candidate.title}
                                </div>
                                <div className="truncate text-[11px] text-neutral-500">
                                  {candidate.artist}
                                  {candidate.durationMs
                                    ? ` · ${formatDuration(candidate.durationMs)}`
                                    : ""}
                                </div>
                              </div>
                              <IconButton
                                label={`Append "${candidate.title}" to the draft`}
                                icon={<PlusIcon />}
                                onClick={() => appendTrack(candidate)}
                              />
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="py-2 text-xs text-neutral-500">
                          No tracks in this playlist.
                        </p>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </aside>
  );
}
