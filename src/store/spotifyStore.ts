import { create } from "zustand";
import type { SpotifyPlaylistSummary } from "../types";
import { SpotifyAuthExpiredError } from "../spotify/apiClient";
import {
  disconnectFromSpotify,
  getValidAccessToken,
} from "../spotify/authFlow";
import { fetchAllPlaylists, fetchCurrentUser } from "../spotify/playlists";
import { useUiStore } from "./uiStore";

type SpotifyUser = {
  id: string;
  displayName?: string;
  country?: string;
};

type SpotifyStore = {
  user: SpotifyUser | null;
  playlists: SpotifyPlaylistSummary[];
  loadingPlaylists: boolean;
  connected: boolean;

  refreshConnection: (clientId: string | undefined) => Promise<void>;
  loadPlaylists: (clientId: string) => Promise<void>;
  disconnect: () => void;
};

export const useSpotifyStore = create<SpotifyStore>((set) => ({
  user: null,
  playlists: [],
  loadingPlaylists: false,
  connected: false,

  async refreshConnection(clientId) {
    if (!clientId) {
      set({ connected: false, user: null });
      return;
    }
    try {
      await getValidAccessToken(clientId);
      const user = await fetchCurrentUser(clientId);
      set({
        connected: true,
        user: {
          id: user.id,
          displayName: user.display_name,
          country: user.country,
        },
      });
    } catch {
      set({ connected: false, user: null });
    }
  },

  async loadPlaylists(clientId) {
    set({ loadingPlaylists: true });
    try {
      const playlists = await fetchAllPlaylists(clientId);
      set({ playlists });
    } catch (error) {
      console.error("loadPlaylists failed", error);
      if (error instanceof SpotifyAuthExpiredError) {
        set({ connected: false, user: null });
        useUiStore.getState().pushToast({
          kind: "error",
          message: "Spotify session expired — reconnect in Settings",
        });
      } else {
        useUiStore.getState().pushToast({
          kind: "error",
          message: "Couldn't load Spotify playlists",
        });
      }
    } finally {
      set({ loadingPlaylists: false });
    }
  },

  disconnect() {
    disconnectFromSpotify();
    set({ connected: false, user: null, playlists: [] });
  },
}));
