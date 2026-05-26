import { create } from "zustand";
import {
  DEFAULT_ACCEPT_MB,
  DEFAULT_ACCEPT_SPOTIFY_HIGH,
  SETTINGS_STORAGE_KEY,
} from "../constants";
import type { Settings } from "../types";

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
  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
}

type SettingsStore = {
  settings: Settings;
  update: (patch: Partial<Settings>) => void;
};

export const useSettingsStore = create<SettingsStore>((set, get) => ({
  settings: loadSettingsFromStorage(),
  update(patch) {
    const next = { ...get().settings, ...patch };
    persistSettings(next);
    set({ settings: next });
  },
}));
