import type { SpotifyMatchStatus } from "../types";
import { CircleGlyphIcon } from "./icons";

type Props = {
  status: SpotifyMatchStatus;
  onPick?: () => void;
};

const STATUS_LABELS: Record<SpotifyMatchStatus, string> = {
  idle: "Spotify match not yet looked up",
  pending: "Searching Spotify…",
  matched: "Matched on Spotify (click to pick a different version)",
  ambiguous: "Ambiguous — click to pick a Spotify version",
  missing: "No match found on Spotify (click to re-search)",
};

const STATUS_COLORS: Record<SpotifyMatchStatus, string> = {
  idle: "text-neutral-500",
  pending: "text-neutral-400 animate-pulse",
  matched: "text-matched cursor-pointer",
  ambiguous: "text-ambiguous cursor-pointer",
  missing: "text-missing cursor-pointer",
};

const INTERACTIVE_STATUSES: SpotifyMatchStatus[] = [
  "matched",
  "ambiguous",
  "missing",
];

function renderGlyphBody(status: SpotifyMatchStatus) {
  if (status === "pending") return "…";
  return <CircleGlyphIcon filled={status !== "idle"} />;
}

export function StatusGlyph({ status, onPick }: Props) {
  const isInteractive =
    INTERACTIVE_STATUSES.includes(status) && Boolean(onPick);
  const className = `inline-flex items-center justify-center text-base ${STATUS_COLORS[status]}`;
  const body = renderGlyphBody(status);
  if (isInteractive) {
    return (
      <button
        type="button"
        aria-label={STATUS_LABELS[status]}
        title={STATUS_LABELS[status]}
        onClick={onPick}
        className={className}
      >
        {body}
      </button>
    );
  }
  return (
    <span
      aria-label={STATUS_LABELS[status]}
      title={STATUS_LABELS[status]}
      className={className}
    >
      {body}
    </span>
  );
}
