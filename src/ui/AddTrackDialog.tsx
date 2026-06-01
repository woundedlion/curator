import { useEffect, useState } from "react";
import { useBackdropDismiss } from "../hooks/useBackdropDismiss";
import { useDialogFocus } from "../hooks/useDialogFocus";
import {
  candidatePlaybackId,
  usePlaybackStore,
} from "../playback/playbackStore";
import { addCandidateTrack } from "../services/addTrackController";
import { searchSpotifyCandidatesByFields } from "../spotify/spotifySearch";
import { useSettingsStore } from "../store/settingsStore";
import { useSpotifyStore } from "../store/spotifyStore";
import { useUiStore } from "../store/uiStore";
import type { SpotifyCandidate } from "../types";
import { SpotifyCandidateRow } from "./SpotifyCandidateRow";
import { Spinner } from "./Spinner";

type Props = {
  onClose: () => void;
};

// Add a single track to the draft by searching Spotify (DESIGN §4.7.1).
// Mirrors the picker's search/playback wiring but, instead of re-pointing
// an existing row, APPENDS the chosen candidate as a brand-new matched
// track. The dialog stays open after each add so the user can add several
// in one session; already-added uris are checked off in the list.
export function AddTrackDialog({ onClose }: Props) {
  const clientId = useSettingsStore((state) => state.settings.spotifyClientId);
  const preferFullPlayback = useSettingsStore(
    (state) => state.settings.preferFullPlayback,
  );
  const market = useSpotifyStore((state) => state.user?.country);
  const pushToast = useUiStore((state) => state.pushToast);
  const playbackTrackId = usePlaybackStore((state) => state.currentTrackId);
  const playbackIsPlaying = usePlaybackStore((state) => state.isPlaying);
  const sdkStatus = usePlaybackStore((state) => state.sdk.status);
  const playCandidate = usePlaybackStore((state) => state.playCandidate);
  const stopPlayback = usePlaybackStore((state) => state.stop);

  const [titleInput, setTitleInput] = useState("");
  const [artistInput, setArtistInput] = useState("");
  const [candidates, setCandidates] = useState<SpotifyCandidate[]>([]);
  const [searched, setSearched] = useState(false);
  const [searching, setSearching] = useState(false);
  // uris already added this session — checked off so a double-click doesn't
  // read as a no-op and the user can see what they've pulled in.
  const [addedUris, setAddedUris] = useState<Set<string>>(() => new Set());

  const dialogRef = useDialogFocus<HTMLDivElement>(true, onClose);
  const backdropDismiss = useBackdropDismiss(onClose);

  // Stop any dialog-initiated candidate playback on unmount (same rationale
  // as the picker — route through the queued stopIfCandidate so an in-flight
  // play is still caught).
  useEffect(() => {
    return () => {
      usePlaybackStore.getState().stopIfCandidate();
    };
  }, []);

  const sdkAvailable =
    Boolean(preferFullPlayback && clientId) &&
    (sdkStatus === "ready" || sdkStatus === "off" || sdkStatus === "loading");

  async function runSearch() {
    if (searching) return;
    if (!clientId) {
      pushToast({
        kind: "error",
        message: "Connect to Spotify in Settings before searching",
      });
      return;
    }
    if (!titleInput.trim() && !artistInput.trim()) return;
    setSearching(true);
    try {
      const next = await searchSpotifyCandidatesByFields(
        { title: titleInput, artist: artistInput },
        clientId,
        market,
      );
      setCandidates(next);
      setSearched(true);
      if (next.length === 0) {
        pushToast({ kind: "info", message: "No Spotify results for that query" });
      }
    } catch (error) {
      console.error("add-track search failed", error);
      const detail =
        error instanceof Error ? error.message : "see console for details";
      pushToast({ kind: "error", message: `Search failed: ${detail}` });
    } finally {
      setSearching(false);
    }
  }

  function handleAdd(candidate: SpotifyCandidate) {
    // Stop candidate preview before the row lands in the main view so the
    // dialog doesn't leave a dangling candidate target.
    usePlaybackStore.getState().stopIfCandidate();
    addCandidateTrack(candidate);
    setAddedUris((prev) => {
      const next = new Set(prev);
      next.add(candidate.uri);
      return next;
    });
    pushToast({
      kind: "success",
      message: `Added "${candidate.title}" to the draft`,
    });
  }

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/70 p-4"
      {...backdropDismiss}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-track-dialog-title"
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
        className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-lg bg-neutral-900 p-4 shadow-xl"
      >
        <div className="mb-3">
          <h2 id="add-track-dialog-title" className="text-base font-semibold">
            Add a track from Spotify
          </h2>
          <p className="text-xs text-neutral-400">
            Search Spotify and click a result to append it to the draft.
          </p>
        </div>

        <div className="mb-3 grid grid-cols-[1fr_1fr_auto] gap-2">
          <input
            type="text"
            value={titleInput}
            onChange={(e) => setTitleInput(e.target.value)}
            placeholder="Title"
            autoFocus
            className="rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-sm"
            onKeyDown={(e) => {
              if (e.key === "Enter") void runSearch();
            }}
          />
          <input
            type="text"
            value={artistInput}
            onChange={(e) => setArtistInput(e.target.value)}
            placeholder="Artist"
            className="rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-sm"
            onKeyDown={(e) => {
              if (e.key === "Enter") void runSearch();
            }}
          />
          <button
            type="button"
            onClick={() => void runSearch()}
            disabled={searching}
            className="rounded bg-matched px-3 py-1 text-sm font-semibold text-neutral-900 hover:opacity-90 disabled:opacity-40"
          >
            {searching ? "…" : "Search"}
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-auto pr-1">
          {searching ? (
            <div className="flex items-center justify-center py-6">
              <Spinner size="md" label="Searching Spotify" />
            </div>
          ) : candidates.length === 0 ? (
            <p className="py-4 text-sm text-neutral-400">
              {searched
                ? "No results — try a different title or artist."
                : "Enter a title and/or artist and click Search."}
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {candidates.map((candidate) => {
                const candidateActive =
                  playbackTrackId === candidatePlaybackId(candidate.uri);
                return (
                  <li key={candidate.uri}>
                    <SpotifyCandidateRow
                      candidate={candidate}
                      isCurrent={addedUris.has(candidate.uri)}
                      currentLabel="✓ added"
                      sdkAvailable={sdkAvailable}
                      isPlaying={candidateActive && playbackIsPlaying}
                      onTogglePlayback={() => {
                        if (candidateActive) {
                          stopPlayback();
                        } else {
                          void playCandidate(candidate);
                        }
                      }}
                      onPick={() => handleAdd(candidate)}
                    />
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="mt-3 flex justify-end">
          <button
            type="button"
            className="rounded border border-neutral-700 px-3 py-1 text-sm hover:bg-neutral-800"
            onClick={onClose}
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
