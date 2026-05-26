import { useSpotifyStore } from "../store/spotifyStore";
import { useUiStore } from "../store/uiStore";

function describeUser(displayName: string | undefined, id: string | undefined): string {
  if (displayName) return displayName;
  if (id) return id;
  return "Spotify";
}

export function ConnectionBadge() {
  const connected = useSpotifyStore((state) => state.connected);
  const user = useSpotifyStore((state) => state.user);
  const openSettings = useUiStore((state) => state.setShowSettings);

  const label = connected
    ? `Connected to Spotify as ${describeUser(user?.displayName, user?.id)}`
    : "Not connected to Spotify";

  return (
    <button
      type="button"
      onClick={() => openSettings(true)}
      aria-label={label}
      title={label}
      className="flex items-center gap-2 bg-transparent px-2 py-1 text-xs transition-opacity hover:opacity-80"
    >
      <span
        aria-hidden
        className={`inline-block h-2.5 w-2.5 rounded-full ${
          connected ? "bg-matched" : "bg-neutral-600"
        }`}
      />
      <span className="truncate max-w-[10rem]">
        {connected
          ? describeUser(user?.displayName, user?.id)
          : "Not connected"}
      </span>
    </button>
  );
}
