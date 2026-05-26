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

  const dialogRef = useDialogFocus<HTMLDivElement>(Boolean(trackId), onClose);

  if (!trackId || !track) return null;
  const candidates = track.enrichment.candidates ?? [];

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Pick a MusicBrainz match"
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/70 p-4"
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="w-full max-w-xl rounded-lg bg-neutral-900 p-4 shadow-xl"
      >
        <h2 className="mb-3 text-base font-semibold">
          Pick a MusicBrainz match
          <span className="block text-xs font-normal text-neutral-400">
            {track.artist ?? "Unknown artist"} —{" "}
            {track.title ?? "Unknown title"}
          </span>
        </h2>

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
                    updateTrack(trackId, {
                      enrichment: {
                        status: "matched",
                        candidates,
                        score: candidate.score,
                        mbRecordingId: candidate.recordingId,
                        userOverride: true,
                      },
                      title: candidate.title,
                      artist: candidate.artist,
                      album: candidate.album ?? track.album,
                      year: candidate.year ?? track.year,
                      originalYear: candidate.originalYear ?? track.originalYear,
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
