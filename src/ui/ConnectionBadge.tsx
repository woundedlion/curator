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
      {/*
        Color + glyph — a circle alone is color-only. The "✓" / "✕"
        gives the same info to anyone with monochromacy and to anyone
        reading at a low-contrast angle (sunlight on a laptop screen).
      */}
      <span
        aria-hidden
        className={`inline-flex h-3.5 w-3.5 items-center justify-center rounded-full text-[8px] font-bold leading-none ${
          connected
            ? "bg-matched text-neutral-900"
            : "bg-neutral-700 text-neutral-300"
        }`}
      >
        {connected ? "✓" : "✕"}
      </span>
      <span className="truncate max-w-[10rem]">
        {connected
          ? describeUser(user?.displayName, user?.id)
          : "Not connected"}
      </span>
    </button>
  );
}
