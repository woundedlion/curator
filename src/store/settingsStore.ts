import { create } from "zustand";
import {
  DEFAULT_ACCEPT_MB,
  DEFAULT_ACCEPT_SPOTIFY_HIGH,
  SETTINGS_STORAGE_KEY,
} from "../constants";
import type { Settings } from "../types";
import { notifySettingsPersistFailure } from "./persistNotifications";

const defaultSettings: Settings = {
  spotifyClientId: undefined,
  spotifyRedirectUri:
    typeof window === "undefined" ? "" : window.location.origin + "/",
  recursiveFolderScan: true,
  acceptThresholds: {
    mb: DEFAULT_ACCEPT_MB,
    spotify: DEFAULT_ACCEPT_SPOTIFY_HIGH,
  },
  musicbrainzContact: "",
  preferFullPlayback: false,
};

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function sanitizeSettings(parsed: unknown): Settings {
  if (parsed === null || typeof parsed !== "object") return defaultSettings;
  const p = parsed as Record<string, unknown>;
  const thresholdsRaw =
    p.acceptThresholds && typeof p.acceptThresholds === "object"
      ? (p.acceptThresholds as Record<string, unknown>)
      : {};
  const mb = isFiniteNumber(thresholdsRaw.mb)
    ? Math.min(1, Math.max(0, thresholdsRaw.mb))
    : defaultSettings.acceptThresholds.mb;
  const spotify = isFiniteNumber(thresholdsRaw.spotify)
    ? Math.min(1, Math.max(0, thresholdsRaw.spotify))
    : defaultSettings.acceptThresholds.spotify;
  return {
    spotifyClientId:
      typeof p.spotifyClientId === "string" ? p.spotifyClientId : undefined,
    spotifyRedirectUri:
      typeof p.spotifyRedirectUri === "string"
        ? p.spotifyRedirectUri
        : defaultSettings.spotifyRedirectUri,
    recursiveFolderScan:
      typeof p.recursiveFolderScan === "boolean"
        ? p.recursiveFolderScan
        : defaultSettings.recursiveFolderScan,
    acceptThresholds: { mb, spotify },
    musicbrainzContact:
      typeof p.musicbrainzContact === "string"
        ? p.musicbrainzContact
        : defaultSettings.musicbrainzContact,
    preferFullPlayback:
      typeof p.preferFullPlayback === "boolean"
        ? p.preferFullPlayback
        : defaultSettings.preferFullPlayback,
  };
}

function loadSettingsFromStorage(): Settings {
  if (typeof window === "undefined") return defaultSettings;
  const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
  if (!raw) return defaultSettings;
  try {
    return sanitizeSettings(JSON.parse(raw));
  } catch {
    return defaultSettings;
  }
}

function persistSettings(settings: Settings): void {
  if (typeof window === "undefined") return;
  // localStorage.setItem can throw — quota exceeded, or a SecurityError in
  // Safari Private Browsing where the quota is effectively zero. This runs
  // inside the Zustand `set` updater (see `update` below), so an uncaught
  // throw would propagate out of `set` and interrupt the state commit,
  // leaving the in-memory store unchanged. Swallow it here so the commit
  // always lands; surface a single latched toast so the user knows their
  // settings won't survive a reload.
  try {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  } catch (error) {
    notifySettingsPersistFailure(error);
  }
}

type SettingsStore = {
  settings: Settings;
  update: (patch: Partial<Settings>) => void;
};

export const useSettingsStore = create<SettingsStore>((set) => ({
  settings: loadSettingsFromStorage(),
  update(patch) {
    // Use the functional `set` form so the patch sees the latest state
    // (matters if two updates race) and we can collapse read+write into
    // one atomic step. persistSettings is called inside set so the
    // localStorage and store states stay aligned — and it swallows its
    // own write failures (see persistSettings) so a storage throw can't
    // interrupt this state commit. The in-memory update always lands.
    set((state) => {
      const next = { ...state.settings, ...patch };
      persistSettings(next);
      return { settings: next };
    });
  },
}));
