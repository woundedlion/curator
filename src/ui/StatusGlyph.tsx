import type { SpotifyMatchStatus } from "../types";

type Props = {
  status: SpotifyMatchStatus;
  onPick?: () => void;
};

const STATUS_LABELS: Record<SpotifyMatchStatus, string> = {
  idle: "Spotify match pending",
  pending: "Searching Spotify…",
  matched: "Matched on Spotify (click to pick a different version)",
  ambiguous: "Ambiguous — click to pick a Spotify version",
  missing: "Not available on Spotify (click to re-search)",
};

// Distinct shapes — not just filled/half/open variants of the same
// circle — so colorblind users (and anyone reading at a glance) can
// tell the four states apart by silhouette alone:
//   ✓ checkmark — matched
//   ? question — ambiguous (user input needed)
//   ✕ cross — missing
//   – dash — idle (nothing has happened yet)
const STATUS_GLYPHS: Record<SpotifyMatchStatus, string> = {
  idle: "–",
  pending: "…",
  matched: "✓",
  ambiguous: "?",
  missing: "✕",
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

export function StatusGlyph({ status, onPick }: Props) {
  const isInteractive =
    INTERACTIVE_STATUSES.includes(status) && Boolean(onPick);
  const className = `inline-flex items-center justify-center text-base ${STATUS_COLORS[status]}`;
  if (isInteractive) {
    return (
      <button
        type="button"
        aria-label={STATUS_LABELS[status]}
        title={STATUS_LABELS[status]}
        onClick={onPick}
        className={className}
      >
        {STATUS_GLYPHS[status]}
      </button>
    );
  }
  return (
    <span
      aria-label={STATUS_LABELS[status]}
      title={STATUS_LABELS[status]}
      className={className}
    >
      {STATUS_GLYPHS[status]}
    </span>
  );
}
