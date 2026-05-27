import { usePlaylistStore } from "../store/playlistStore";

type Props = {
  hiddenCount: number;
};

// Shown when the user has tracks in the draft but every one is filtered
// out by `hideUnmatched`. Without this, the playlist body is just blank
// and the user has no idea why their tracks disappeared.
export function EmptyFilterState({ hiddenCount }: Props) {
  const setHideUnmatched = usePlaylistStore((state) => state.setHideUnmatched);

  return (
    <div className="flex flex-1 items-center justify-center p-10 text-center">
      <div className="max-w-md rounded-2xl border-2 border-dashed border-neutral-800 p-8">
        <h2 className="text-lg font-semibold text-neutral-100">
          All tracks hidden by filter
        </h2>
        <p className="mt-2 text-sm text-neutral-400">
          {hiddenCount === 1
            ? "1 track is hidden because it isn't matched on Spotify yet."
            : `${hiddenCount} tracks are hidden because they aren't matched on Spotify yet.`}
        </p>
        <button
          type="button"
          onClick={() => setHideUnmatched(false)}
          className="mt-4 rounded bg-matched px-4 py-2 text-sm font-semibold text-neutral-900 hover:opacity-90"
        >
          Show all tracks
        </button>
      </div>
    </div>
  );
}
