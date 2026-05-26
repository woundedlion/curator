import { SPOTIFY_PLAYBACK_SDK_URL } from "../constants";
import { callSpotify } from "./apiClient";
import { getValidAccessToken } from "./authFlow";

const SDK_INIT_TIMEOUT_MS = 10_000;

type SpotifyPlayerInstance = {
  connect: () => Promise<boolean>;
  disconnect: () => void;
  addListener: (event: string, callback: (data: unknown) => void) => boolean;
  pause: () => Promise<void>;
  resume: () => Promise<void>;
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
    window.onSpotifyWebPlaybackSDKReady = () => resolve();
    const script = document.createElement("script");
    script.src = SPOTIFY_PLAYBACK_SDK_URL;
    script.async = true;
    script.onerror = () => reject(new Error("Failed to load Spotify SDK"));
    document.head.appendChild(script);
  });
  return sdkLoadPromise;
}

export type PlayerInitResult =
  | { ok: true; deviceId: string; player: SpotifyPlayerInstance }
  | { ok: false; reason: "not-premium" | "auth" | "unknown"; message: string };

export async function initializeSpotifyPlayer(
  clientId: string,
): Promise<PlayerInitResult> {
  await loadSdk();
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

    void player.connect();
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

export type { SpotifyPlayerInstance };
