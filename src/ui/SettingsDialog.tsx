import { useEffect, useState } from "react";
import { useDialogFocus } from "../hooks/useDialogFocus";
import { clearMusicbrainzCache } from "../db/musicbrainzCache";
import { useSettingsStore } from "../store/settingsStore";
import { useSpotifyStore } from "../store/spotifyStore";
import { useUiStore } from "../store/uiStore";
import {
  resetSpotifyCircuit,
  spotifyCircuitOpenMs,
} from "../spotify/apiClient";
import { beginAuthFlow } from "../spotify/authFlow";
import { clearAutoReconnectSuppression } from "../services/spotifyBootstrap";
import { ConfirmDialog } from "./ConfirmDialog";

function emptyToUndefined(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

export function SettingsDialog() {
  const open = useUiStore((state) => state.showSettings);
  const closeDialog = () => useUiStore.getState().setShowSettings(false);
  const settings = useSettingsStore((state) => state.settings);
  const updateSettings = useSettingsStore((state) => state.update);
  const spotifyConnected = useSpotifyStore((state) => state.connected);
  const spotifyUser = useSpotifyStore((state) => state.user);
  const disconnect = useSpotifyStore((state) => state.disconnect);
  const pushToast = useUiStore((state) => state.pushToast);

  const dialogRef = useDialogFocus<HTMLDivElement>(open, closeDialog);
  const [pendingClearCache, setPendingClearCache] = useState(false);

  // Live-tick the displayed circuit countdown. `spotifyCircuitOpenMs()` is
  // a pure read (`circuitOpenUntil - Date.now()`) — no fetch, no token
  // refresh, no probe — so polling it can never cost the user a request
  // or extend a penalty. We still self-stop the interval the moment the
  // remaining time hits zero (and avoid scheduling it at all when the
  // breaker is closed) so an idle Settings dialog isn't re-rendering
  // every second for nothing.
  const [remainingMs, setRemainingMs] = useState(() => spotifyCircuitOpenMs());
  // Resync remaining time when the dialog reopens. This is the
  // documented "storing information from previous renders" pattern
  // (https://react.dev/reference/react/useState#storing-information-from-previous-renders):
  // comparing a tracked prior value to the current render's value
  // and resetting derived state during render. NOT a side-effect-in-
  // render violation — it's the explicit React idiom for deriving
  // state from a prop without an effect cycle.
  const [openWhenSynced, setOpenWhenSynced] = useState(open);
  if (openWhenSynced !== open) {
    setOpenWhenSynced(open);
    if (open) setRemainingMs(spotifyCircuitOpenMs());
  }
  useEffect(() => {
    if (!open) return;
    if (spotifyCircuitOpenMs() <= 0) return;
    const id = window.setInterval(() => {
      const next = spotifyCircuitOpenMs();
      setRemainingMs(next);
      if (next <= 0) window.clearInterval(id);
    }, 1000);
    return () => window.clearInterval(id);
  }, [open]);

  if (!open) return null;

  async function connect() {
    if (!settings.spotifyClientId) return;
    // Explicit user action overrides the auto-reconnect suppression that
    // a prior denial would have set.
    clearAutoReconnectSuppression();
    await beginAuthFlow(settings.spotifyClientId, settings.spotifyRedirectUri);
  }

  function requestClearCache() {
    setPendingClearCache(true);
  }

  async function confirmClearCache() {
    setPendingClearCache(false);
    await clearMusicbrainzCache();
    pushToast({ kind: "info", message: "MusicBrainz cache cleared" });
  }

  function resetSpotifyRateLimit() {
    resetSpotifyCircuit();
    pushToast({
      kind: "info",
      message: "Spotify rate-limit circuit reset — requests resume",
    });
  }

  const circuitRemainingMs = remainingMs;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Settings"
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/70 p-4"
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="w-full max-w-lg rounded-lg bg-neutral-900 p-5 shadow-xl"
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Settings</h2>
          <span className="text-xs text-neutral-500">Changes save automatically</span>
        </div>

        <section className="mb-4">
          <h3 className="mb-1 text-sm font-semibold">MusicBrainz</h3>
          <label className="block text-xs text-neutral-400">
            Contact email (required — sent in User-Agent / client param)
          </label>
          <input
            type="email"
            value={settings.musicbrainzContact}
            onChange={(e) =>
              updateSettings({ musicbrainzContact: e.target.value })
            }
            className="mt-1 w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-sm"
            placeholder="you@example.com"
          />
        </section>

        <section className="mb-4">
          <h3 className="mb-1 text-sm font-semibold">Spotify</h3>
          <label className="block text-xs text-neutral-400">Client ID</label>
          <input
            type="text"
            value={settings.spotifyClientId ?? ""}
            onChange={(e) =>
              updateSettings({
                spotifyClientId: emptyToUndefined(e.target.value),
              })
            }
            className="mt-1 w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-sm"
            placeholder="From developer.spotify.com"
          />
          <label className="mt-2 block text-xs text-neutral-400">
            Redirect URI
          </label>
          <input
            type="text"
            value={settings.spotifyRedirectUri}
            onChange={(e) =>
              updateSettings({ spotifyRedirectUri: e.target.value })
            }
            className="mt-1 w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-sm"
          />
          <p className="mt-1 text-xs text-neutral-500">
            Register the exact Redirect URI in the Spotify dashboard.
          </p>

          <label className="mt-3 flex items-center gap-2 text-xs text-neutral-300">
            <input
              type="checkbox"
              checked={settings.preferFullPlayback}
              onChange={(e) =>
                updateSettings({ preferFullPlayback: e.target.checked })
              }
            />
            Full-track playback (requires Spotify Premium; reconnect after
            enabling to grant the new scopes)
          </label>

          <div className="mt-3 flex items-center gap-2">
            {spotifyConnected ? (
              <>
                <span className="text-xs text-neutral-400">
                  Connected as {spotifyUser?.displayName ?? spotifyUser?.id}
                </span>
                <button
                  type="button"
                  onClick={disconnect}
                  className="ml-auto rounded border border-neutral-700 px-2 py-1 text-xs hover:bg-neutral-800"
                >
                  Disconnect
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={connect}
                disabled={!settings.spotifyClientId}
                className="rounded bg-matched px-3 py-1 text-xs font-semibold text-black hover:opacity-90 disabled:opacity-40"
              >
                Connect to Spotify
              </button>
            )}
          </div>

          {circuitRemainingMs > 0 && (
            <div className="mt-3 flex items-center gap-2 rounded border border-ambiguous/40 bg-ambiguous/10 px-2 py-2 text-xs text-ambiguous">
              <span className="flex-1">
                Rate-limit pause active ({Math.ceil(circuitRemainingMs / 1000)}s
                remaining). Spotify requests are paused.
              </span>
              <button
                type="button"
                onClick={resetSpotifyRateLimit}
                className="rounded border border-ambiguous/60 px-2 py-1 hover:bg-ambiguous/20"
              >
                Reset now
              </button>
            </div>
          )}
        </section>

        <section className="mb-4">
          <h3 className="mb-1 text-sm font-semibold">Cache</h3>
          <button
            type="button"
            onClick={requestClearCache}
            className="rounded border border-neutral-700 px-2 py-1 text-xs hover:bg-neutral-800"
          >
            Clear MusicBrainz cache
          </button>
        </section>

        <div className="mt-2 flex justify-end">
          <button
            type="button"
            onClick={closeDialog}
            className="rounded border border-neutral-700 px-3 py-1 text-sm hover:bg-neutral-800"
          >
            Close
          </button>
        </div>
      </div>
      <ConfirmDialog
        open={pendingClearCache}
        title="Clear MusicBrainz cache?"
        message="All cached MusicBrainz results will be discarded. The next enrichment pass will re-fetch every track from MusicBrainz (subject to the 1 req/sec rate limit)."
        confirmLabel="Clear"
        kind="danger"
        onConfirm={confirmClearCache}
        onCancel={() => setPendingClearCache(false)}
      />
    </div>
  );
}
