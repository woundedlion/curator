import { useEffect, useMemo, useState } from "react";
import { useBackdropDismiss } from "../hooks/useBackdropDismiss";
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
import type { SpotifyCandidate, Track } from "../types";
import { formatDuration } from "../util/duration";
import { getSpotifyPreviewUrl } from "../util/trackAccessors";
import { PauseIcon, PlayIcon } from "./icons";
import { SpotifyCandidateRow } from "./SpotifyCandidateRow";
import { Spinner } from "./Spinner";

type WorkflowControls = {
  // 1-based position and count for the "Resolving N of M" label.
  position: number;
  total: number;
  // Advance to the next work item without resolving the current one
  // (Skip button / Right arrow).
  onSkip: () => void;
  // Step back to the previous work item (Back button / Left arrow). No-op
  // at the first item — the dialog gates on `position > 1`.
  onBack: () => void;
  // Called after a pick commits so the workflow can advance to the next.
  onResolved: () => void;
};

type Props = {
  trackId: string;
  onClose: () => void;
  // Present only when launched from the rapid-disambiguation workflow
  // (§4.7.5). Normal single-row picker opens leave this undefined.
  workflow?: WorkflowControls;
};

// Human-readable "where this row came from" line for the Original section.
function sourceLabel(track: Track): string {
  switch (track.source.kind) {
    case "file":
      return `Local file · ${track.source.fileName}`;
    case "text":
    case "m3u":
      return track.source.rawLine
        ? `Text · ${track.source.rawLine}`
        : "Text source";
    case "spotify-import":
      return "Imported from Spotify";
  }
}

// The Original row: shows the track's source + current identity and lets
// the user play the ORIGINAL audio (local file / preview) to A/B against
// the candidates. Distinct from candidate playback — it plays the row
// itself via playOriginalFile (DESIGN §4.7.2).
function OriginalRow({ track }: { track: Track }) {
  const playbackTrackId = usePlaybackStore((state) => state.currentTrackId);
  const playbackIsPlaying = usePlaybackStore((state) => state.isPlaying);
  const playOriginalFile = usePlaybackStore((state) => state.playOriginalFile);

  const playable = Boolean(track.localFile) || Boolean(getSpotifyPreviewUrl(track.spotify));
  const isActive = playbackTrackId === track.id;
  const isPlaying = isActive && playbackIsPlaying;

  const yearPart = track.year ? ` · ${track.year}` : "";
  const detail = [
    track.artist ?? "Unknown artist",
    "—",
    track.title ?? "Unknown title",
  ].join(" ");

  const playLabel = playable
    ? isPlaying
      ? "Pause original"
      : track.localFile
        ? "Play original file"
        : "Play original preview"
    : "No original file or preview to play";

  return (
    <div className="mb-3 rounded border border-neutral-800 bg-neutral-900/40 p-2">
      <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-neutral-500">
        Original
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          aria-label={playLabel}
          title={playLabel}
          disabled={!playable}
          onClick={() => playOriginalFile(track.id)}
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded bg-transparent text-matched transition-opacity hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-25"
        >
          {isPlaying ? <PauseIcon /> : <PlayIcon />}
        </button>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{detail}</div>
          <div className="truncate text-xs text-neutral-400">
            {sourceLabel(track)}
            {track.album ? ` · ${track.album}` : ""}
            {yearPart}
            {track.durationMs ? ` · ${formatDuration(track.durationMs)}` : ""}
          </div>
        </div>
      </div>
    </div>
  );
}

export function AmbiguousMatchDialog({ trackId, onClose, workflow }: Props) {
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
  const backdropDismiss = useBackdropDismiss(onClose);

  // Left/Right arrows step the disambiguation workflow back/forward. Ignored
  // outside the workflow, and ignored while the caret is in the search
  // inputs (where the arrows move the text cursor). Bound on the panel so it
  // only fires while focus is trapped inside the dialog.
  function handleWorkflowKeys(event: React.KeyboardEvent<HTMLDivElement>) {
    if (!workflow) return;
    const target = event.target as HTMLElement;
    if (
      target.tagName === "INPUT" ||
      target.tagName === "TEXTAREA" ||
      target.isContentEditable
    ) {
      return;
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      workflow.onSkip();
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      if (workflow.position > 1) workflow.onBack();
    }
  }

  // Stop any dialog-initiated candidate playback on unmount. We route
  // through the player's `stopIfCandidate` so the check happens
  // INSIDE the playback operation queue — if a candidate's `play`
  // is still in flight when the dialog unmounts, the enqueued
  // `stopIfCandidate` runs after the play lands and still catches it.
  // A point-in-time read of `currentTrackId` from the cleanup would
  // miss that race. (Original-file playback is a `track` target and is
  // intentionally NOT stopped — see DESIGN §4.7.2.)
  useEffect(() => {
    return () => {
      usePlaybackStore.getState().stopIfCandidate();
    };
  }, []);

  const candidates = useMemo<SpotifyCandidate[]>(() => {
    let source: SpotifyCandidate[] = [];
    if (searchedCandidates) {
      source = searchedCandidates;
    } else if (track) {
      const match = track.spotify;
      if (match.status === "matched" || match.status === "ambiguous") {
        source = match.candidates;
      }
    }
    // Dedupe by uri: a re-search merge can occasionally surface the same
    // Spotify track twice, which would collide on the `key={candidate.uri}`
    // list keys below (React duplicate-key warning + reconciliation bugs).
    // Keeping the first occurrence preserves search-rank order.
    const seen = new Set<string>();
    return source.filter((c) => {
      if (seen.has(c.uri)) return false;
      seen.add(c.uri);
      return true;
    });
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
      // SettingsDialog so all dialogs dismiss the same way. useBackdropDismiss
      // (not a bare onClick) so selecting text in an input and releasing the
      // drag outside the panel doesn't synthesize a backdrop click and close
      // the dialog mid-edit — only a press that starts AND ends on the
      // backdrop dismisses.
      {...backdropDismiss}
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
        onKeyDown={handleWorkflowKeys}
        className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-lg bg-neutral-900 p-4 shadow-xl"
      >
        <div className="mb-3 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2
              id="ambiguous-match-dialog-title"
              className="text-base font-semibold"
            >
              Pick a Spotify version
            </h2>
            <p className="truncate text-xs text-neutral-400">
              {track.artist ?? "Unknown artist"} —{" "}
              {track.title ?? "Unknown title"}
            </p>
          </div>
          {workflow && (
            <div className="flex shrink-0 items-center gap-2">
              <span className="text-xs text-neutral-400 tabular-nums">
                Resolving {workflow.position} of {workflow.total}
              </span>
              <button
                type="button"
                onClick={workflow.onBack}
                disabled={workflow.position <= 1}
                title="Previous track (←)"
                className="rounded border border-neutral-700 px-2 py-1 text-xs hover:bg-neutral-800 disabled:opacity-40"
              >
                Back
              </button>
              <button
                type="button"
                onClick={workflow.onSkip}
                title="Skip to next track (→)"
                className="rounded border border-neutral-700 px-2 py-1 text-xs hover:bg-neutral-800"
              >
                Skip
              </button>
            </div>
          )}
        </div>

        <OriginalRow track={track} />

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
                    <SpotifyCandidateRow
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
                          // dialog open and PIN the current candidate list
                          // so it survives the row flipping to "missing"
                          // (which carries no candidates of its own) — the
                          // user can then pick a different version or close,
                          // and a rapid reopen still shows the list. Snapshot
                          // into a fresh array so the pinned value is fully
                          // detached from the store's render-closure
                          // reference and can't be invalidated underneath us.
                          const pinned = [...candidates];
                          unpickSpotifyMatch(trackId);
                          setSearchedCandidates(pinned);
                          return;
                        }
                        void pickSpotifyCandidate(
                          trackId,
                          candidate,
                          candidates,
                        );
                        // In the workflow, a pick advances to the next work
                        // item; otherwise close the one-off picker.
                        if (workflow) {
                          workflow.onResolved();
                        } else {
                          onClose();
                        }
                      }}
                    />
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="mt-3 flex justify-end">
          {/* "Done", not "Cancel": every action in this picker (pick,
              unpick/re-ambiguate) is committed to the store the instant it's
              clicked — there is no pending draft to discard. A "Cancel" label
              wrongly implies closing would revert an unpick, so the button is
              an affirmative close that keeps the change. In the workflow it
              stops the guided pass and returns to the table. */}
          <button
            type="button"
            className="rounded border border-neutral-700 px-3 py-1 text-sm hover:bg-neutral-800"
            onClick={onClose}
          >
            {workflow ? "Stop" : "Done"}
          </button>
        </div>
      </div>
    </div>
  );
}
