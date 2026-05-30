import { create } from "zustand";
import type { SpotifyPlaylistSummary } from "../types";
import {
  SpotifyAuthExpiredError,
  SpotifyRateLimitError,
} from "../spotify/apiClient";
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

// Connection state machine:
//
//   unconfigured ──set clientId──▶  disconnected
//                                       │
//                                       │ refreshConnection success
//                                       ▼
//                                  connected ──disconnect──▶ disconnected
//                                       │
//                                       │ refreshConnection 401 / refresh failed
//                                       ▼
//                                  disconnected
//
//   Any state can transiently be "rate-limited": we couldn't even ASK
//   Spotify whether we're connected. This is distinct from
//   disconnected — the auto-reconnect bootstrap path must NOT redirect
//   to OAuth on rate limit (the redirect itself doesn't help, just
//   confuses the user).
export type ConnectionStatus =
  | "unconfigured"
  | "disconnected"
  | "connected"
  | "rate-limited";

type SpotifyStore = {
  user: SpotifyUser | null;
  playlists: SpotifyPlaylistSummary[];
  loadingPlaylists: boolean;
  connected: boolean;
  // Distinguishes "we know we're not connected" from "we couldn't
  // check because Spotify is rate-limiting us". The bootstrap reads
  // this before deciding whether to trigger auto-reconnect.
  status: ConnectionStatus;

  refreshConnection: (clientId: string | undefined) => Promise<void>;
  loadPlaylists: (clientId: string) => Promise<void>;
  disconnect: () => void;
};

// Inflight dedup for loadPlaylists. Concurrent calls (e.g. bootstrap +
// user opens the panel) would each set loadingPlaylists/playlists in an
// unpredictable order. Share the promise so all callers observe one run.
// Keyed on clientId: a concurrent caller with a DIFFERENT clientId must
// NOT ride the first call's result — that would surface the wrong
// account's playlists. Only same-clientId callers dedup.
let loadPlaylistsInflight:
  | { clientId: string; promise: Promise<void> }
  | null = null;

export const useSpotifyStore = create<SpotifyStore>((set) => ({
  user: null,
  playlists: [],
  loadingPlaylists: false,
  connected: false,
  status: "unconfigured",

  async refreshConnection(clientId) {
    if (!clientId) {
      set({ connected: false, user: null, status: "unconfigured" });
      return;
    }
    try {
      await getValidAccessToken(clientId);
      const user = await fetchCurrentUser(clientId);
      set({
        connected: true,
        status: "connected",
        user: {
          id: user.id,
          displayName: user.display_name,
          country: user.country,
        },
      });
    } catch (error) {
      // Rate limit is distinct from auth-expired: we couldn't check.
      // The bootstrap reads `status` and skips auto-reconnect when
      // rate-limited (redirecting to OAuth doesn't help and just
      // confuses the user — the OAuth flow itself can't proceed
      // because token exchange shares the same quota).
      if (error instanceof SpotifyRateLimitError) {
        set({ connected: false, user: null, status: "rate-limited" });
        return;
      }
      if (!(error instanceof SpotifyAuthExpiredError)) {
        console.warn("refreshConnection failed", error);
      }
      set({ connected: false, user: null, status: "disconnected" });
    }
  },

  async loadPlaylists(clientId) {
    // Dedup only when the in-flight run is for the SAME clientId. A call
    // with a different clientId starts its own run so it can't be handed
    // the wrong account's playlists.
    if (loadPlaylistsInflight && loadPlaylistsInflight.clientId === clientId) {
      return loadPlaylistsInflight.promise;
    }
    const promise = doLoadPlaylists(clientId, set).finally(() => {
      // Only clear the slot if it's still ours — a later different-client
      // call may have replaced it while we were running.
      if (loadPlaylistsInflight?.promise === promise) {
        loadPlaylistsInflight = null;
      }
    });
    loadPlaylistsInflight = { clientId, promise };
    return promise;
  },

  disconnect() {
    disconnectFromSpotify();
    set({
      connected: false,
      user: null,
      playlists: [],
      status: "disconnected",
    });
  },
}));

async function doLoadPlaylists(
  clientId: string,
  set: (
    patch:
      | Partial<SpotifyStore>
      | ((state: SpotifyStore) => Partial<SpotifyStore>),
  ) => void,
): Promise<void> {
  set({ loadingPlaylists: true });
  try {
    const playlists = await fetchAllPlaylists(clientId);
    set({ playlists });
  } catch (error) {
    console.error("loadPlaylists failed", error);
    if (error instanceof SpotifyAuthExpiredError) {
      set({ connected: false, user: null, status: "disconnected" });
      useUiStore.getState().pushToast({
        kind: "error",
        message: "Spotify session expired — reconnect in Settings",
      });
    } else if (error instanceof SpotifyRateLimitError) {
      // Don't clobber `connected` on rate limit — we ARE connected,
      // we just got throttled. The user can retry once the circuit
      // closes. The rate-limit toast already fired from apiClient.
      set({ status: "rate-limited" });
    } else {
      useUiStore.getState().pushToast({
        kind: "error",
        message: "Couldn't load Spotify playlists",
      });
    }
  } finally {
    set({ loadingPlaylists: false });
  }
}
