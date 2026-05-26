import type { EnrichmentStatus } from "../types";

type Props = {
  status: EnrichmentStatus;
  onPick?: () => void;
};

const STATUS_LABELS: Record<EnrichmentStatus, string> = {
  idle: "MusicBrainz enrichment pending",
  pending: "Looking up MusicBrainz…",
  matched: "Enriched from MusicBrainz",
  ambiguous: "Ambiguous MusicBrainz match — click to pick",
  failed: "MusicBrainz lookup failed",
};

const STATUS_GLYPHS: Record<EnrichmentStatus, string> = {
  idle: "·",
  pending: "…",
  matched: "●",
  ambiguous: "◐",
  failed: "✗",
};

const STATUS_COLORS: Record<EnrichmentStatus, string> = {
  idle: "text-neutral-500",
  pending: "text-neutral-400 animate-pulse",
  matched: "text-matched",
  ambiguous: "text-ambiguous cursor-pointer",
  failed: "text-red-500",
};

export function EnrichmentGlyph({ status, onPick }: Props) {
  const isInteractive = status === "ambiguous" && Boolean(onPick);
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
