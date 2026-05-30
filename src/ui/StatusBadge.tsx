import { CircleGlyphIcon } from "./icons";

// Shared rendering for status-circle badges (Spotify match column, MB
// enrichment column). The two callers pass their own status enum's
// label/color/interactive maps; this component owns the markup +
// interactive-vs-static branch.

type Props<S extends string> = {
  status: S;
  labels: Record<S, string>;
  colors: Record<S, string>;
  interactiveStatuses: readonly S[];
  // The two discriminators the badge renders against, supplied by the
  // caller and typed as `S` so they're checked against the caller's own
  // status enum. This replaces the prior `("pending" as S)` /
  // `("idle" as S)` casts, which defeated type-checking: a caller whose
  // enum lacked those literals (or renamed them) would have silently
  // compared against a string that never matched.
  pendingStatus: S;
  idleStatus: S;
  onPick?: () => void;
};

export function StatusBadge<S extends string>({
  status,
  labels,
  colors,
  interactiveStatuses,
  pendingStatus,
  idleStatus,
  onPick,
}: Props<S>) {
  const isInteractive =
    interactiveStatuses.includes(status) && Boolean(onPick);
  const className = `inline-flex items-center justify-center text-base ${colors[status]}`;
  const body =
    status === pendingStatus ? (
      "…"
    ) : (
      <CircleGlyphIcon filled={status !== idleStatus} />
    );
  if (isInteractive) {
    return (
      <button
        type="button"
        aria-label={labels[status]}
        title={labels[status]}
        onClick={onPick}
        className={className}
      >
        {body}
      </button>
    );
  }
  return (
    <span
      aria-label={labels[status]}
      title={labels[status]}
      className={className}
    >
      {body}
    </span>
  );
}
