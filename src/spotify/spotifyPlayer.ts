import { SPOTIFY_PLAYBACK_SDK_URL } from "../constants";
import { callSpotify } from "./apiClient";
import { getValidAccessToken } from "./authFlow";

const SDK_INIT_TIMEOUT_MS = 10_000;

type SpotifyPlayerListener = (data: unknown) => void;

type SpotifyPlayerInstance = {
  connect: () => Promise<boolean>;
  disconnect: () => void;
  addListener: (event: string, callback: SpotifyPlayerListener) => boolean;
  removeListener: (event: string, callback?: SpotifyPlayerListener) => boolean;
  pause: () => Promise<void>;
  resume: () => Promise<void>;
  seek: (positionMs: number) => Promise<void>;
  getCurrentState: () => Promise<SpotifyPlayerSdkState | null>;
};

// Subset of the SDK's `player_state_changed` payload that we read.
export type SpotifyPlayerSdkState = {
  paused: boolean;
  position: number;
  duration: number;
};

type SpotifyPlayerConstructor = new (options: {
  name: string;
  getOAuthToken: (cb: (token: string) => void) => void;
  volume?: number;
}) => SpotifyPlayerInstance;

type SpotifyNamespace = { Player: SpotifyPlayerConstructor };

declare global {
  interface Window {
    Spotify?: SpotifyNamespace;
    onSpotifyWebPlaybackSDKReady?: () => void;
  }
}

let sdkLoadPromise: Promise<void> | null = null;

function loadSdk(): Promise<void> {
  if (window.Spotify) return Promise.resolve();
  if (sdkLoadPromise) return sdkLoadPromise;

  sdkLoadPromise = new Promise<void>((resolve, reject) => {
    // Bound the wait for `onSpotifyWebPlaybackSDKReady`. The script can
    // load successfully (no `onerror`) yet never fire the ready callback
    // — e.g. the CDN serves a build that fails to self-initialize, or a
    // CSP/extension blocks its internal setup. Without this timer the
    // promise stays pending forever and, because `sdkLoadPromise` is
    // cached, EVERY later retry reuses the same dead promise and also
    // hangs. On timeout we clear the cache (mirroring the onerror path)
    // so a subsequent call can re-append the script and try again.
    const timeoutHandle = setTimeout(() => {
      sdkLoadPromise = null;
      reject(
        new Error(
          `Spotify SDK script loaded but did not initialize within ${SDK_INIT_TIMEOUT_MS / 1000}s`,
        ),
      );
    }, SDK_INIT_TIMEOUT_MS);

    window.onSpotifyWebPlaybackSDKReady = () => {
      clearTimeout(timeoutHandle);
      resolve();
    };
    const script = document.createElement("script");
    script.src = SPOTIFY_PLAYBACK_SDK_URL;
    script.async = true;
    script.onerror = () => {
      // Clear the cached promise so a future call can retry the script
      // load — otherwise every subsequent attempt sees the rejected
      // promise and never tries again.
      clearTimeout(timeoutHandle);
      sdkLoadPromise = null;
      reject(new Error("Failed to load Spotify SDK"));
    };
    document.head.appendChild(script);
  });
  return sdkLoadPromise;
}

export type PlayerInitResult =
  | { ok: true; deviceId: string; player: SpotifyPlayerInstance }
  | { ok: false; reason: "not-premium" | "auth" | "unknown"; message: string };

export type SpotifyPlayerHandlers = {
  /** Device dropped out after init (sleep, takeover, network drop). */
  onNotReady?: () => void;
  /** Post-init playback error (DRM, decode, etc.) — SDK-supplied message. */
  onError?: (message: string) => void;
};

// Cache the in-flight init promise + resolved success result. Every
// caller that asks for a Player gets the same instance — re-instantiating
// would create a duplicate Spotify Connect device and waste a WebSocket
// connection per call.
let activeInitPromise: Promise<PlayerInitResult> | null = null;
let activeOkPlayer: SpotifyPlayerInstance | null = null;
let activeOkDeviceId: string | null = null;

export async function destroySpotifyPlayer(): Promise<void> {
  if (activeOkPlayer) {
    try {
      activeOkPlayer.disconnect();
    } catch (error) {
      console.warn("destroySpotifyPlayer: disconnect threw", error);
    }
  }
  activeOkPlayer = null;
  activeOkDeviceId = null;
  activeInitPromise = null;
}

export function initializeSpotifyPlayer(
  clientId: string,
  handlers: SpotifyPlayerHandlers = {},
): Promise<PlayerInitResult> {
  if (activeOkPlayer && activeOkDeviceId) {
    return Promise.resolve({
      ok: true,
      deviceId: activeOkDeviceId,
      player: activeOkPlayer,
    });
  }
  if (activeInitPromise) return activeInitPromise;
  activeInitPromise = doInitializeSpotifyPlayer(clientId, handlers).then((result) => {
    if (result.ok) {
      activeOkPlayer = result.player;
      activeOkDeviceId = result.deviceId;
    } else {
      // Failure — drop the cached promise so a follow-up call can retry
      // (e.g. user toggles preferFullPlayback off and on).
      activeInitPromise = null;
    }
    return result;
  });
  return activeInitPromise;
}

async function doInitializeSpotifyPlayer(
  clientId: string,
  handlers: SpotifyPlayerHandlers,
): Promise<PlayerInitResult> {
  try {
    await loadSdk();
  } catch (error) {
    // loadSdk rejects on script.onerror OR on the ready-callback timeout
    // (finding #5). Surface as a normal init failure so the caller's
    // .then runs and clears activeInitPromise — letting a later retry
    // re-attempt instead of awaiting a rejected/pending promise forever.
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: "unknown", message };
  }
  const SpotifyNs = window.Spotify;
  if (!SpotifyNs) {
    return { ok: false, reason: "unknown", message: "Spotify SDK unavailable" };
  }

  const player = new SpotifyNs.Player({
    name: "Curator",
    getOAuthToken: (cb) => {
      void getValidAccessToken(clientId).then(cb).catch(() => cb(""));
    },
    volume: 0.6,
  });

  return new Promise<PlayerInitResult>((resolve) => {
    let settled = false;
    function settle(result: PlayerInitResult) {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      resolve(result);
    }

    // The SDK is supposed to fire `ready` or one of the `*_error` events
    // after `connect()`. If neither fires (e.g. CSP blocks the EME license
    // server), the promise would otherwise hang forever and pin the
    // playback store in `loading`. Bound the wait so a hang surfaces as
    // a normal init failure and the preview-fallback path engages.
    const timeoutHandle = setTimeout(() => {
      settle({
        ok: false,
        reason: "unknown",
        message: `SDK did not respond within ${SDK_INIT_TIMEOUT_MS / 1000}s`,
      });
    }, SDK_INIT_TIMEOUT_MS);

    player.addListener("ready", (data) => {
      const deviceId = (data as { device_id?: string }).device_id;
      if (deviceId) settle({ ok: true, deviceId, player });
    });

    // Device dropped out after init (sleep, network drop, taken over by
    // another tab). Notify so the playback store can reset to "idle"
    // instead of issuing play commands against a dead device id.
    player.addListener("not_ready", () => {
      handlers.onNotReady?.();
    });

    // Generic playback error from the SDK (DRM failures, codec issues,
    // etc.) — bubble to the playback store for a toast. These fire AFTER
    // init, so they don't interact with the settle() guard.
    player.addListener("playback_error", (data) => {
      const message =
        (data as { message?: string }).message ?? "playback failed";
      handlers.onError?.(message);
    });

    player.addListener("initialization_error", (data) => {
      const message =
        (data as { message?: string }).message ?? "initialization failed";
      settle({ ok: false, reason: "unknown", message });
    });

    player.addListener("authentication_error", (data) => {
      const message =
        (data as { message?: string }).message ?? "auth failed";
      settle({ ok: false, reason: "auth", message });
    });

    player.addListener("account_error", (data) => {
      const message =
        (data as { message?: string }).message ??
        "Premium subscription required";
      settle({ ok: false, reason: "not-premium", message });
    });

    // connect() may reject synchronously (e.g. EME unavailable). Surface
    // that through settle() instead of letting the rejection float until
    // the 10s timeout — users get a faster, more accurate error message.
    player.connect().catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      settle({ ok: false, reason: "unknown", message });
    });
  });
}

export async function playSpotifyTrackOnDevice(
  uri: string,
  deviceId: string,
  clientId: string,
): Promise<void> {
  await callSpotify(
    {
      path: "/me/player/play",
      method: "PUT",
      query: { device_id: deviceId },
      body: { uris: [uri] },
    },
    clientId,
    // Playback is user-triggered and latency-sensitive — let it cut
    // ahead of any queued background search/enrichment traffic. Still
    // bound by the rate limiter and the circuit breaker.
    { priority: "high" },
  );
}

export async function pauseSpotifyPlayback(
  player: SpotifyPlayerInstance,
): Promise<void> {
  await player.pause();
}

export async function resumeSpotifyPlayback(
  player: SpotifyPlayerInstance,
): Promise<void> {
  await player.resume();
}

export async function seekSpotifyPlayback(
  player: SpotifyPlayerInstance,
  positionMs: number,
): Promise<void> {
  await player.seek(Math.max(0, Math.floor(positionMs)));
}

export type { SpotifyPlayerInstance, SpotifyPlayerListener };
