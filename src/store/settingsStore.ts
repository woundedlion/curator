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

function loadSettingsFromStorage(): Settings {
  if (typeof window === "undefined") return defaultSettings;
  const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
  if (!raw) return defaultSettings;
  try {
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return { ...defaultSettings, ...parsed };
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
