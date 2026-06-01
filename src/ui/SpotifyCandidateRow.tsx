import type { SpotifyCandidate } from "../types";
import { formatDuration } from "../util/duration";
import { ExternalLinkIcon, PauseIcon, PlayIcon } from "./icons";

// Shared between the disambiguation picker (AmbiguousMatchDialog) and the
// add-track dialog (AddTrackDialog) so the two render Spotify search
// results identically — cover, title/artist/album·year·duration, and the
// preview/SDK/external-link playback control. Keeping one component means
// a change to candidate presentation can't drift between the two surfaces.

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

export function SpotifyCandidateRow({
  candidate,
  isCurrent,
  sdkAvailable,
  isPlaying,
  onTogglePlayback,
  onPick,
  currentLabel = "✓ current",
}: {
  candidate: SpotifyCandidate;
  isCurrent: boolean;
  sdkAvailable: boolean;
  isPlaying: boolean;
  onTogglePlayback: () => void;
  onPick: () => void;
  // Badge text shown when `isCurrent` — "✓ current" in the picker, "✓ added"
  // in the add-track dialog.
  currentLabel?: string;
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
              <span className="ml-2 text-xs text-matched">{currentLabel}</span>
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
