import type { EnrichmentStatus } from "../types";
import { CircleGlyphIcon } from "./icons";

type Props = {
  status: EnrichmentStatus;
  onPick?: () => void;
};

const STATUS_LABELS: Record<EnrichmentStatus, string> = {
  idle: "MusicBrainz enrichment not yet looked up",
  pending: "Looking up MusicBrainz…",
  matched: "Enriched from MusicBrainz (click to pick a different candidate)",
  ambiguous: "Ambiguous MusicBrainz match — click to pick",
  failed: "No MusicBrainz match found (click to re-pick from candidates)",
};

const STATUS_COLORS: Record<EnrichmentStatus, string> = {
  idle: "text-neutral-500",
  pending: "text-neutral-400 animate-pulse",
  matched: "text-matched cursor-pointer",
  ambiguous: "text-ambiguous cursor-pointer",
  failed: "text-missing cursor-pointer",
};

const INTERACTIVE_STATUSES: EnrichmentStatus[] = [
  "matched",
  "ambiguous",
  "failed",
];

function renderGlyphBody(status: EnrichmentStatus) {
  if (status === "pending") return "…";
  return <CircleGlyphIcon filled={status !== "idle"} />;
}

export function EnrichmentGlyph({ status, onPick }: Props) {
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
