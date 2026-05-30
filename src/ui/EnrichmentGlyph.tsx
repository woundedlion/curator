import type { EnrichmentStatus } from "../types";
import { StatusBadge } from "./StatusBadge";

const LABELS: Record<EnrichmentStatus, string> = {
  idle: "MusicBrainz enrichment not yet looked up",
  pending: "Looking up MusicBrainz…",
  matched: "Enriched from MusicBrainz (click to pick a different candidate)",
  ambiguous: "Ambiguous MusicBrainz match — click to pick",
  failed: "No MusicBrainz match found (click to re-pick from candidates)",
};

const COLORS: Record<EnrichmentStatus, string> = {
  idle: "text-neutral-500",
  pending: "text-neutral-400 animate-pulse",
  matched: "text-matched cursor-pointer",
  ambiguous: "text-ambiguous cursor-pointer",
  failed: "text-missing cursor-pointer",
};

const INTERACTIVE: readonly EnrichmentStatus[] = [
  "matched",
  "ambiguous",
  "failed",
];

export function EnrichmentGlyph({
  status,
  onPick,
}: {
  status: EnrichmentStatus;
  onPick?: () => void;
}) {
  return (
    <StatusBadge
      status={status}
      labels={LABELS}
      colors={COLORS}
      interactiveStatuses={INTERACTIVE}
      pendingStatus="pending"
      idleStatus="idle"
      onPick={onPick}
    />
  );
}
