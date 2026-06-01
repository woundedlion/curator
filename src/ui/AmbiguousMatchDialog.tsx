import { useEffect, useMemo, useState } from "react";
import { useDialogFocus } from "../hooks/useDialogFocus";
import {
  candidatePlaybackId,
  usePlaybackStore,
} from "../playback/playbackStore";
import {
  pickSpotifyCandidate,
  unpickSpotifyMatch,
} from "../services/spotifyPicker";
import { searchSpotifyCandidatesByFields } from "../spotify/spotifySearch";
import { usePlaylistStore } from "../store/playlistStore";
import { useSettingsStore } from "../store/settingsStore";
import { useSpotifyStore } from "../store/spotifyStore";
import { useUiStore } from "../store/uiStore";
import type { SpotifyCandidate } from "../types";
import { formatDuration } from "../util/duration";
import { ExternalLinkIcon, PauseIcon, PlayIcon } from "./icons";
import { Spinner } from "./Spinner";

type Props = {
  trackId: string;
  onClose: () => void;
};

type PreviewMode = "preview" | "sdk" | "external";

function previewModeFor(
  candidate: SpotifyCandidate,
  sdkAvailable: boolean,
): PreviewMode {
  if (candidate.previewUrl) return "preview";
  if (sdkAvailable) return "sdk";
  return "external";
}

function spotifyTrackUrl(candidate: SpotifyCandidate): string {
  return `https://open.spotify.com/track/${candidate.id}`;
}

function PreviewControl({
  candidate,
  mode,
  isPlaying,
  onToggle,
}: {
  candidate: SpotifyCandidate;
  mode: PreviewMode;
  isPlaying: boolean;
  onToggle: () => void;
}) {
  if (mode === "external") {
    return (
      <a
        href={spotifyTrackUrl(candidate)}
        target="_blank"
        rel="noopener noreferrer"
        aria-label="Open in Spotify"
        title="Open in Spotify (no preview available)"
        className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded bg-transparent text-matched transition-opacity hover:opacity-80"
      >
        <ExternalLinkIcon />
      </a>
    );
  }
  const label = isPlaying
    ? mode === "sdk"
      ? "Pause"
      : "Pause preview"
    : mode === "sdk"
      ? "Play full track"
      : "Play preview";
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onToggle}
      className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded bg-transparent text-matched transition-opacity hover:opacity-80"
    >
      {isPlaying ? <PauseIcon /> : <PlayIcon />}
    </button>
  );
}

function CandidateRow({
  candidate,
  isCurrent,
  sdkAvailable,
  isPlaying,
  onTogglePlayback,
  onPick,
}: {
  candidate: SpotifyCandidate;
  isCurrent: boolean;
  sdkAvailable: boolean;
  isPlaying: boolean;
  onTogglePlayback: () => void;
  onPick: () => void;
}) {
  const yearPart = candidate.year ? ` · ${candidate.year}` : "";
  const mode = previewModeFor(candidate, sdkAvailable);
  return (
    <div className="flex items-center gap-2">
      <PreviewControl
        candidate={candidate}
        mode={mode}
        isPlaying={isPlaying}
        onToggle={onTogglePlayback}
      />
      <button
        type="button"
        onClick={onPick}
        className={`flex min-w-0 flex-1 items-center gap-3 rounded border px-3 py-2 text-left transition-colors ${
          isCurrent
            ? "border-matched bg-neutral-800/60"
            : "border-neutral-800 hover:bg-neutral-800"
        }`}
      >
        {candidate.coverUrl ? (
          <img
            src={candidate.coverUrl}
            alt=""
            loading="lazy"
            className="h-10 w-10 rounded object-cover"
          />
        ) : (
          <div className="h-10 w-10 rounded bg-neutral-800" aria-hidden />
        )}
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">
            {candidate.title}
            {isCurrent && (
              <span className="ml-2 text-xs text-matched">✓ current</span>
            )}
          </div>
          <div className="truncate text-xs text-neutral-400">
            {candidate.artist}
            {candidate.album ? ` · ${candidate.album}` : ""}
            {yearPart}
            {" · "}
            {formatDuration(candidate.durationMs)}
          </div>
        </div>
      </button>
    </div>
  );
}

export function AmbiguousMatchDialog({ trackId, onClose }: Props) {
  // The parent gates mount on `trackId !== null` and passes
  // `key={trackId}`, so every picker session is a fresh component
  // instance — initial state below initializes naturally per track,
  // and the trackId/track references stay stable for this lifetime.
  const track = usePlaylistStore((state) => state.tracksById[trackId]);
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

  const [titleInput, setTitleInput] = useState(track?.title ?? "");
  const [artistInput, setArtistInput] = useState(track?.artist ?? "");
  const [searchedCandidates, setSearchedCandidates] = useState<
    SpotifyCandidate[] | null
  >(null);
  const [searching, setSearching] = useState(false);

  const dialogRef = useDialogFocus<HTMLDivElement>(true, onClose);

  // Stop any dialog-initiated candidate playback on unmount. We route
  // through the player's `stopIfCandidate` so the check happens
  // INSIDE the playback operation queue — if a candidate's `play`
  // is still in flight when the dialog unmounts, the enqueued
  // `stopIfCandidate` runs after the play lands and still catches it.
  // A point-in-time read of `currentTrackId` from the cleanup would
  // miss that race.
  useEffect(() => {
    return () => {
      usePlaybackStore.getState().stopIfCandidate();
    };
  }, []);

  const candidates = useMemo<SpotifyCandidate[]>(() => {
    if (searchedCandidates) return searchedCandidates;
    if (!track) return [];
    const match = track.spotify;
    if (match.status === "matched" || match.status === "ambiguous") {
      return match.candidates;
    }
    return [];
  }, [searchedCandidates, track]);

  // SDK is "available" if the user has opted in and either it's already
  // ready or it can be lazily initialized when playCandidate is called.
  const sdkAvailable =
    Boolean(preferFullPlayback && clientId) &&
    (sdkStatus === "ready" || sdkStatus === "off" || sdkStatus === "loading");

  // `shouldApply` lets the caller abandon all post-await side effects
  // (state writes + toasts) when the search has been superseded — used
  // by the mount auto-search to bail if the dialog unmounts mid-flight.
  // It defaults to always-apply for the synchronous Search-button path,
  // which is only reachable while the dialog is mounted anyway.
  async function runSearchWithFields(
    title: string | undefined,
    artist: string | undefined,
    shouldApply: () => boolean = () => true,
  ) {
    if (!clientId) {
      pushToast({
        kind: "error",
        message: "Connect to Spotify in Settings before searching",
      });
      return;
    }
    setSearching(true);
    try {
      const next = await searchSpotifyCandidatesByFields(
        { title, artist },
        clientId,
        market,
      );
      if (!shouldApply()) return;
      setSearchedCandidates(next);
      if (next.length === 0) {
        pushToast({ kind: "info", message: "No Spotify results for that query" });
      }
    } catch (error) {
      console.error("re-search failed", error);
      if (!shouldApply()) return;
      const detail =
        error instanceof Error ? error.message : "see console for details";
      pushToast({ kind: "error", message: `Search failed: ${detail}` });
    } finally {
      if (shouldApply()) setSearching(false);
    }
  }

  function runSearchAgain() {
    // Guard against overlapping searches. The Search button is disabled
    // while `searching`, but the inputs' Enter-key handlers are not, so
    // without this a user hammering Enter could fire concurrent searches
    // whose responses resolve out of order — an older query overwriting a
    // newer one's results.
    if (searching) return;
    void runSearchWithFields(titleInput, artistInput);
  }

  // Curator-export round-trips drop the `candidates[]` array (DESIGN §4.5.1
  // serializes only the chosen `spotifyUri`), so a re-imported track opens
  // this dialog with no list to pick from. Auto-fire the search once on
  // mount against a candidate-less track that has enough metadata to
  // query, so the user lands on a populated picker without an extra
  // click. The parent's key={trackId} guarantees this effect runs exactly
  // once per picker session.
  useEffect(() => {
    if (!track || !clientId) return;
    const match = track.spotify;
    const existing =
      match.status === "matched" || match.status === "ambiguous"
        ? match.candidates
        : [];
    if (existing.length > 0) return;
    if (!track.title && !track.artist) return;
    // Cancellation guard: the search is async, so if the user closes the
    // dialog (this component unmounts) before it resolves, the cleanup
    // flips `ignore` and `runSearchWithFields` skips every state write
    // and the "No Spotify results" toast — no setState-on-unmounted and
    // no toast for a dialog the user already dismissed.
    let ignore = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void runSearchWithFields(track.title, track.artist, () => !ignore);
    return () => {
      ignore = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!track) return null;
  const currentUri =
    track.spotify.status === "matched" || track.spotify.status === "ambiguous"
      ? track.spotify.uri
      : undefined;

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/70 p-4"
      // Clicking the backdrop cancels (== onClose), matching ConfirmDialog/
      // SettingsDialog so all dialogs dismiss the same way. This picker is
      // fully cancelable, so backdrop-close is safe (no destructive footgun).
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        // role/aria-modal/aria-label live on the focus-trapped panel, not
        // the backdrop, so a screen reader entering the dialog lands on the
        // element that actually carries the dialog semantics.
        role="dialog"
        aria-modal="true"
        // Name the dialog from its visible heading (aria-labelledby) rather
        // than a separate aria-label that can drift from the <h2> text.
        aria-labelledby="ambiguous-match-dialog-title"
        tabIndex={-1}
        // Stop clicks inside the panel from bubbling to the backdrop's
        // onClose, so interacting with the dialog doesn't dismiss it.
        onClick={(event) => event.stopPropagation()}
        className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-lg bg-neutral-900 p-4 shadow-xl"
      >
        <div className="mb-3">
          <h2 id="ambiguous-match-dialog-title" className="text-base font-semibold">
            Pick a Spotify version
          </h2>
          <p className="text-xs text-neutral-400">
            {track.artist ?? "Unknown artist"} — {track.title ?? "Unknown title"}
          </p>
        </div>

        <div className="mb-3 grid grid-cols-[1fr_1fr_auto] gap-2">
          <input
            type="text"
            value={titleInput}
            onChange={(e) => setTitleInput(e.target.value)}
            placeholder="Title"
            className="rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-sm"
            onKeyDown={(e) => {
              if (e.key === "Enter") void runSearchAgain();
            }}
          />
          <input
            type="text"
            value={artistInput}
            onChange={(e) => setArtistInput(e.target.value)}
            placeholder="Artist"
            className="rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-sm"
            onKeyDown={(e) => {
              if (e.key === "Enter") void runSearchAgain();
            }}
          />
          <button
            type="button"
            onClick={runSearchAgain}
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
              No candidates yet. Edit the title or artist and click Search.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {candidates.map((candidate) => {
                const candidateActive =
                  playbackTrackId === candidatePlaybackId(candidate.uri);
                return (
                  <li key={candidate.uri}>
                    <CandidateRow
                      candidate={candidate}
                      isCurrent={candidate.uri === currentUri}
                      sdkAvailable={sdkAvailable}
                      isPlaying={candidateActive && playbackIsPlaying}
                      onTogglePlayback={() => {
                        if (candidateActive) {
                          stopPlayback();
                        } else {
                          void playCandidate(candidate);
                        }
                      }}
                      onPick={() => {
                        // Stop only candidate-scoped playback so we
                        // don't disturb anything the user had playing
                        // from the main view.
                        usePlaybackStore.getState().stopIfCandidate();
                        if (candidate.uri === currentUri) {
                          // Clicking the already-selected match toggles it
                          // off: revert the row to unmatched. Keep the
                          // dialog open and pin the candidate list (the
                          // row's status flips to "missing", which carries
                          // no candidates of its own) so the click visibly
                          // de-highlights this row and the user can pick a
                          // different version or close.
                          setSearchedCandidates(candidates);
                          unpickSpotifyMatch(trackId);
                          return;
                        }
                        void pickSpotifyCandidate(
                          trackId,
                          candidate,
                          candidates,
                        );
                        onClose();
                      }}
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
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
