import { useUiStore } from "../store/uiStore";
import { Spinner } from "./Spinner";

type Props = {
  onPickFolder: () => void;
};

export function EmptyState({ onPickFolder }: Props) {
  const busy = useUiStore((state) => state.busyCount > 0);

  if (busy) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-10 text-center text-neutral-400">
        <Spinner size="md" label="Adding files" />
        <p className="text-sm">Adding tracks…</p>
      </div>
    );
  }

  return (
    <div className="flex flex-1 items-center justify-center p-10 text-center">
      <div className="max-w-md rounded-2xl border-2 border-dashed border-neutral-800 p-10">
        <h2 className="text-lg font-semibold">Start a playlist</h2>
        <p className="mt-2 text-sm text-neutral-400">
          Drop one or more folders of music, a text file with song names, or
          an .m3u playlist anywhere on this window.
        </p>
        <button
          type="button"
          onClick={onPickFolder}
          className="mt-4 rounded bg-matched px-4 py-2 text-sm font-semibold text-neutral-900 hover:opacity-90"
        >
          Pick folder
        </button>
        <p className="mt-3 text-xs text-neutral-500">
          You can also paste a song list into a .txt file and drop it here.
        </p>
      </div>
    </div>
  );
}
