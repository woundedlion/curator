import { useBackdropDismiss } from "../hooks/useBackdropDismiss";
import { useDialogFocus } from "../hooks/useDialogFocus";
import { usePlaylistStore } from "../store/playlistStore";

type Props = {
  trackId: string | null;
  onClose: () => void;
};

function formatCandidateLabel(
  title: string,
  artist: string,
  album: string | undefined,
  year: number | undefined,
): string {
  const albumPart = album ? ` · ${album}` : "";
  const yearPart = year ? ` (${year})` : "";
  return `${title} — ${artist}${albumPart}${yearPart}`;
}

export function AmbiguousEnrichmentDialog({ trackId, onClose }: Props) {
  const track = usePlaylistStore((state) =>
    trackId ? state.tracksById[trackId] : null,
  );
  const updateTrack = usePlaylistStore((state) => state.updateTrack);
  const fillMissingDisplayFields = usePlaylistStore(
    (state) => state.fillMissingDisplayFields,
  );

  const dialogRef = useDialogFocus<HTMLDivElement>(Boolean(trackId), onClose);
  const backdropDismiss = useBackdropDismiss(onClose);

  if (!trackId || !track) return null;
  const candidates =
    track.enrichment.status === "matched" ||
    track.enrichment.status === "ambiguous" ||
    track.enrichment.status === "failed"
      ? (track.enrichment.candidates ?? [])
      : [];

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/70 p-4"
      // Backdrop click dismisses (== onClose). useBackdropDismiss so a
      // text-selection drag that releases outside the panel can't synthesize
      // a backdrop click and close the dialog mid-edit (see the hook).
      {...backdropDismiss}
    >
      <div
        ref={dialogRef}
        // role/aria-modal/aria-label live on the focus-trapped panel
        // (the element useDialogFocus manages), not the backdrop, so a
        // screen reader entering the dialog lands on the element that
        // actually carries the dialog semantics.
        role="dialog"
        aria-modal="true"
        // Name the dialog from its visible heading (aria-labelledby) rather
        // than a separate aria-label that can drift from the <h2> text.
        aria-labelledby="ambiguous-enrichment-dialog-title"
        tabIndex={-1}
        // Stop clicks inside the panel from bubbling to the backdrop's
        // onClose, so interacting with the dialog doesn't dismiss it.
        onClick={(event) => event.stopPropagation()}
        className="w-full max-w-xl rounded-lg bg-neutral-900 p-4 shadow-xl"
      >
        <div className="mb-3">
          <h2
            id="ambiguous-enrichment-dialog-title"
            className="text-base font-semibold"
          >
            Pick a MusicBrainz match
          </h2>
          <span className="block text-xs font-normal text-neutral-400">
            {track.artist ?? "Unknown artist"} —{" "}
            {track.title ?? "Unknown title"}
          </span>
        </div>

        {candidates.length === 0 ? (
          <p className="text-sm text-neutral-400">No candidates available.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {candidates.map((candidate) => (
              <li key={candidate.recordingId}>
                <button
                  type="button"
                  className="w-full rounded border border-neutral-800 px-3 py-2 text-left text-sm hover:bg-neutral-800"
                  onClick={() => {
                    // MB is supplementary — fill missing fields only.
                    // Routing through fillMissingDisplayFields keeps the
                    // "missing" predicate consistent with every other
                    // call site (treats "" as missing, not just undefined),
                    // and preserves the source-of-truth invariant from
                    // DESIGN §4.3.
                    fillMissingDisplayFields(trackId, {
                      title: candidate.title,
                      artist: candidate.artist,
                      album: candidate.album,
                      year: candidate.year,
                      originalYear: candidate.originalYear,
                    });
                    updateTrack(trackId, {
                      enrichment: {
                        status: "matched",
                        candidates,
                        score: candidate.score,
                        mbRecordingId: candidate.recordingId,
                        userOverride: true,
                      },
                    });
                    onClose();
                  }}
                >
                  {formatCandidateLabel(
                    candidate.title,
                    candidate.artist,
                    candidate.album,
                    candidate.year,
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="mt-4 flex justify-end">
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
