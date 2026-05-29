import { useDialogFocus } from "../hooks/useDialogFocus";
import type { SpotifyPlaylistSummary } from "../types";

type Props = {
  candidateName: string;
  matches: SpotifyPlaylistSummary[];
  onReplace: (playlistId: string) => void;
  onCancel: () => void;
};

function SingleMatchActions({
  match,
  onReplace,
  onCancel,
}: {
  match: SpotifyPlaylistSummary;
  onReplace: (id: string) => void;
  onCancel: () => void;
}) {
  return (
    <>
      <p className="mt-2 text-sm text-neutral-400">
        Replace its tracks with the current draft, or cancel and rename the
        draft first.
      </p>
      <div className="mt-4 flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded border border-neutral-700 px-3 py-1 text-sm hover:bg-neutral-800"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => onReplace(match.id)}
          className="rounded bg-matched px-3 py-1 text-sm font-semibold text-black hover:opacity-90"
        >
          Replace existing
        </button>
      </div>
    </>
  );
}

function MultiMatchPicker({
  matches,
  onReplace,
  onCancel,
}: {
  matches: SpotifyPlaylistSummary[];
  onReplace: (id: string) => void;
  onCancel: () => void;
}) {
  return (
    <>
      <p className="mt-2 text-sm text-neutral-400">
        Several playlists share this name. Pick the one to replace, or cancel.
      </p>
      <ul className="mt-3 flex flex-col gap-2">
        {matches.map((match) => (
          <li key={match.id}>
            <button
              type="button"
              className="w-full rounded border border-neutral-800 px-3 py-2 text-left text-sm hover:bg-neutral-800"
              onClick={() => onReplace(match.id)}
            >
              {match.name}
              <span className="ml-2 text-xs text-neutral-500">
                {match.trackCount === undefined
                  ? "? tracks"
                  : `${match.trackCount} tracks`}
              </span>
            </button>
          </li>
        ))}
      </ul>
      <div className="mt-4 flex justify-end">
        <button
          type="button"
          onClick={onCancel}
          className="rounded border border-neutral-700 px-3 py-1 text-sm hover:bg-neutral-800"
        >
          Cancel
        </button>
      </div>
    </>
  );
}

export function NameCollisionDialog({
  candidateName,
  matches,
  onReplace,
  onCancel,
}: Props) {
  const dialogRef = useDialogFocus<HTMLDivElement>(
    matches.length > 0,
    onCancel,
  );
  if (matches.length === 0) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Existing playlist with the same name"
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/70 p-4"
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="w-full max-w-md rounded-lg bg-neutral-900 p-5 shadow-xl"
      >
        <h2 className="text-base font-semibold">
          You already have a playlist named &ldquo;{candidateName}&rdquo;
        </h2>

        {matches.length === 1 ? (
          <SingleMatchActions
            match={matches[0]!}
            onReplace={onReplace}
            onCancel={onCancel}
          />
        ) : (
          <MultiMatchPicker
            matches={matches}
            onReplace={onReplace}
            onCancel={onCancel}
          />
        )}
      </div>
    </div>
  );
}
