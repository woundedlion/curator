import type { SpotifyMatchStatus } from "../types";
import { StatusBadge } from "./StatusBadge";

const LABELS: Record<SpotifyMatchStatus, string> = {
  idle: "Spotify match not yet looked up",
  pending: "Searching Spotify…",
  matched: "Matched on Spotify (click to pick a different version)",
  ambiguous: "Ambiguous — click to pick a Spotify version",
  missing: "No match found on Spotify (click to re-search)",
};

const COLORS: Record<SpotifyMatchStatus, string> = {
  idle: "text-neutral-500",
  pending: "text-neutral-400 animate-pulse",
  matched: "text-matched cursor-pointer",
  ambiguous: "text-ambiguous cursor-pointer",
  missing: "text-missing cursor-pointer",
};

const INTERACTIVE: readonly SpotifyMatchStatus[] = [
  "matched",
  "ambiguous",
  "missing",
];

export function StatusGlyph({
  status,
  onPick,
}: {
  status: SpotifyMatchStatus;
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
