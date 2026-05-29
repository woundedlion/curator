// Tests for the Spotify connection store. Covers the four behaviors
// flagged by the prior code review:
//
//   1. ConnectionStatus state machine — in particular, "rate-limited"
//      is a PEER of "disconnected" so the bootstrap can skip the
//      OAuth redirect during a 429 cool-off (redirecting through
//      Spotify's authorize endpoint shares the same per-app quota
//      that just 429'd us; dropping the user there mid-throttle is
//      useless and confusing).
//   2. loadPlaylistsInflight dedup — two concurrent loadPlaylists
//      callers must share one fetch run, so their state writes can't
//      interleave.
//   3. disconnect() — clears user/playlists and parks status on
//      "disconnected" (it does NOT derive "unconfigured" from a
//      missing clientId; that's refreshConnection's job).
//   4. setState / subscribe — Zustand's basic setter + notify path
//      works for `user` and `status` as required by external
//      consumers (e.g. spotifyMatchRunner reads `user?.country`).
//
// The Spotify HTTP layer (apiClient / authFlow / playlists) is
// mocked so this stays a pure store test — no IndexedDB, no real
// fetches, no rate-limit machinery.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// localStorage / sessionStorage polyfills — apiClient.ts reads from
// localStorage at module init and authFlow's disconnect path touches
// sessionStorage. We mock authFlow below, but the import graph still
// pulls apiClient in for the error class re-exports.
class MemoryStorage implements Storage {
  private store = new Map<string, string>();
  get length(): number {
    return this.store.size;
  }
  clear(): void {
    this.store.clear();
  }
  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }
  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null;
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
}
vi.stubGlobal("localStorage", new MemoryStorage());
vi.stubGlobal("sessionStorage", new MemoryStorage());

// Toasts fire on auth-expired / generic load failures. Capture them
// so the relevant tests can assert kind/message without coupling to
// the real ui store.
const toasts: { kind: string; message: string }[] = [];
vi.mock("./uiStore", () => ({
  useUiStore: {
    getState: () => ({
      pushToast: (toast: { kind: string; message: string }) => {
        toasts.push(toast);
      },
    }),
  },
}));

// Hoisted mocks so the vi.mock factories below (which are hoisted to
// the top of the file by vitest) can reference them.
const mocks = vi.hoisted(() => ({
  getValidAccessToken: vi.fn<(clientId: string) => Promise<string>>(),
  disconnectFromSpotify: vi.fn<() => void>(),
  fetchCurrentUser: vi.fn<
    (clientId: string) => Promise<{
      id: string;
      display_name?: string;
      country?: string;
    }>
  >(),
  fetchAllPlaylists: vi.fn<
    (
      clientId: string,
    ) => Promise<
      Array<{ id: string; name: string; ownerId: string }>
    >
  >(),
}));

vi.mock("../spotify/authFlow", () => ({
  getValidAccessToken: mocks.getValidAccessToken,
  disconnectFromSpotify: mocks.disconnectFromSpotify,
}));

vi.mock("../spotify/playlists", () => ({
  fetchCurrentUser: mocks.fetchCurrentUser,
  fetchAllPlaylists: mocks.fetchAllPlaylists,
}));

import {
  SpotifyAuthExpiredError,
  SpotifyRateLimitError,
} from "../spotify/apiClient";
import { useSpotifyStore } from "./spotifyStore";

function resetStore(): void {
  useSpotifyStore.setState({
    user: null,
    playlists: [],
    loadingPlaylists: false,
    connected: false,
    status: "unconfigured",
  });
}

beforeEach(() => {
  resetStore();
  toasts.length = 0;
  mocks.getValidAccessToken.mockReset();
  mocks.disconnectFromSpotify.mockReset();
  mocks.fetchCurrentUser.mockReset();
  mocks.fetchAllPlaylists.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("refreshConnection — connection status state machine", () => {
  it("with no clientId, parks status at 'unconfigured' and clears user", async () => {
    // No clientId means the user hasn't entered one in Settings yet.
    // This branch must never throw and must leave the store in the
    // pristine "unconfigured" state that the Settings dialog reads to
    // decide whether to show the Connect button.
    useSpotifyStore.setState({
      connected: true,
      status: "connected",
      user: { id: "old" },
    });
    await useSpotifyStore.getState().refreshConnection(undefined);
    const state = useSpotifyStore.getState();
    expect(state.connected).toBe(false);
    expect(state.user).toBeNull();
    expect(state.status).toBe("unconfigured");
  });

  it("on success, transitions to 'connected' and stores the user", async () => {
    // Happy path: a valid token comes back and /me returns a user.
    // Status flips to "connected" and the user fields are copied across
    // (display_name → displayName, country preserved for market hints).
    mocks.getValidAccessToken.mockResolvedValue("tok");
    mocks.fetchCurrentUser.mockResolvedValue({
      id: "u1",
      display_name: "Alice",
      country: "US",
    });
    await useSpotifyStore.getState().refreshConnection("client-id");
    const state = useSpotifyStore.getState();
    expect(state.connected).toBe(true);
    expect(state.status).toBe("connected");
    expect(state.user).toEqual({
      id: "u1",
      displayName: "Alice",
      country: "US",
    });
  });

  it("on SpotifyRateLimitError, parks at 'rate-limited' (NOT 'disconnected')", async () => {
    // CRITICAL: rate-limited is a peer of disconnected, not a substate.
    // The bootstrap reads `status` and skips the OAuth redirect when
    // rate-limited — redirecting through Spotify's authorize endpoint
    // shares the per-app quota that just 429'd us, so it can't actually
    // proceed and just confuses the user.
    mocks.getValidAccessToken.mockRejectedValue(
      new SpotifyRateLimitError(5_000),
    );
    await useSpotifyStore.getState().refreshConnection("client-id");
    const state = useSpotifyStore.getState();
    expect(state.status).toBe("rate-limited");
    expect(state.connected).toBe(false);
    expect(state.user).toBeNull();
  });

  it("on SpotifyAuthExpiredError, transitions to 'disconnected' silently", async () => {
    // Expired refresh tokens are the common case after a long idle —
    // we don't warn-log them (that's reserved for unexpected failures).
    mocks.getValidAccessToken.mockRejectedValue(new SpotifyAuthExpiredError());
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await useSpotifyStore.getState().refreshConnection("client-id");
    expect(useSpotifyStore.getState().status).toBe("disconnected");
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("on any other error, transitions to 'disconnected' and warn-logs", async () => {
    // Unknown errors (network blip, parse failure, etc.) should still
    // leave the store in a known state — "disconnected" so the
    // bootstrap can offer auto-reconnect — but get logged so the
    // developer notices.
    mocks.getValidAccessToken.mockRejectedValue(new Error("boom"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await useSpotifyStore.getState().refreshConnection("client-id");
    expect(useSpotifyStore.getState().status).toBe("disconnected");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("a previously-connected user is cleared on a refresh failure", async () => {
    // A failed refresh after a successful one should not leave stale
    // user fields around — the Settings dialog and matchRunner both
    // read `user`, and a stale name post-disconnect would be misleading.
    useSpotifyStore.setState({
      connected: true,
      status: "connected",
      user: { id: "stale", displayName: "Stale", country: "US" },
    });
    mocks.getValidAccessToken.mockRejectedValue(new SpotifyAuthExpiredError());
    await useSpotifyStore.getState().refreshConnection("client-id");
    expect(useSpotifyStore.getState().user).toBeNull();
  });
});

describe("loadPlaylists — inflight dedup", () => {
  it("two concurrent calls share one fetch and one state-write sequence", async () => {
    // The module-scope `loadPlaylistsInflight` guard exists because
    // both the bootstrap AND a user opening the Create Playlist panel
    // can fire loadPlaylists in the same tick. Without dedup their
    // state writes (loadingPlaylists / playlists) would interleave
    // unpredictably. Verify both callers wait on the same promise and
    // fetchAllPlaylists runs exactly once.
    let resolveFetch: (
      value: Array<{ id: string; name: string; ownerId: string }>,
    ) => void = () => undefined;
    const fetchPromise = new Promise<
      Array<{ id: string; name: string; ownerId: string }>
    >((resolve) => {
      resolveFetch = resolve;
    });
    mocks.fetchAllPlaylists.mockReturnValue(fetchPromise);

    const a = useSpotifyStore.getState().loadPlaylists("cid");
    const b = useSpotifyStore.getState().loadPlaylists("cid");

    expect(mocks.fetchAllPlaylists).toHaveBeenCalledTimes(1);
    expect(useSpotifyStore.getState().loadingPlaylists).toBe(true);

    resolveFetch([{ id: "p1", name: "One", ownerId: "u" }]);
    await Promise.all([a, b]);

    expect(useSpotifyStore.getState().loadingPlaylists).toBe(false);
    expect(useSpotifyStore.getState().playlists).toEqual([
      { id: "p1", name: "One", ownerId: "u" },
    ]);
  });

  it("after a run finishes, a fresh call kicks off a NEW fetch", async () => {
    // The inflight guard must clear in `.finally()` — otherwise the
    // very first run would permanently lock out all future loads.
    mocks.fetchAllPlaylists.mockResolvedValueOnce([
      { id: "p1", name: "First", ownerId: "u" },
    ]);
    await useSpotifyStore.getState().loadPlaylists("cid");

    mocks.fetchAllPlaylists.mockResolvedValueOnce([
      { id: "p2", name: "Second", ownerId: "u" },
    ]);
    await useSpotifyStore.getState().loadPlaylists("cid");

    expect(mocks.fetchAllPlaylists).toHaveBeenCalledTimes(2);
    expect(useSpotifyStore.getState().playlists).toEqual([
      { id: "p2", name: "Second", ownerId: "u" },
    ]);
  });

  it("releases the inflight guard even when the fetch rejects", async () => {
    // A failed fetch must not poison the guard. Bootstrap retries and
    // user-initiated refreshes both rely on being able to call
    // loadPlaylists again after an error.
    mocks.fetchAllPlaylists.mockRejectedValueOnce(new Error("net"));
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await useSpotifyStore.getState().loadPlaylists("cid");
    expect(useSpotifyStore.getState().loadingPlaylists).toBe(false);

    mocks.fetchAllPlaylists.mockResolvedValueOnce([
      { id: "ok", name: "OK", ownerId: "u" },
    ]);
    await useSpotifyStore.getState().loadPlaylists("cid");
    expect(useSpotifyStore.getState().playlists).toEqual([
      { id: "ok", name: "OK", ownerId: "u" },
    ]);
    err.mockRestore();
  });

  it("on SpotifyAuthExpiredError, clears connection and pushes a reconnect toast", async () => {
    // The bootstrap calls loadPlaylists right after refreshConnection
    // succeeds. If tokens get revoked between those two calls, this
    // path is how the user finds out — auth-expired flips status to
    // "disconnected" and surfaces an actionable toast.
    mocks.fetchAllPlaylists.mockRejectedValueOnce(new SpotifyAuthExpiredError());
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    useSpotifyStore.setState({ connected: true, status: "connected" });
    await useSpotifyStore.getState().loadPlaylists("cid");
    expect(useSpotifyStore.getState().connected).toBe(false);
    expect(useSpotifyStore.getState().status).toBe("disconnected");
    expect(toasts).toEqual([
      {
        kind: "error",
        message: "Spotify session expired — reconnect in Settings",
      },
    ]);
    err.mockRestore();
  });

  it("on SpotifyRateLimitError, sets status='rate-limited' but does NOT clobber 'connected'", async () => {
    // We ARE connected — we just got throttled. Tearing down the
    // connection on every 429 would force the user back through OAuth
    // every time the breaker opens. The toast for rate-limit comes
    // from apiClient, so no toast is pushed here.
    mocks.fetchAllPlaylists.mockRejectedValueOnce(
      new SpotifyRateLimitError(5_000),
    );
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    useSpotifyStore.setState({ connected: true, status: "connected" });
    await useSpotifyStore.getState().loadPlaylists("cid");
    expect(useSpotifyStore.getState().connected).toBe(true);
    expect(useSpotifyStore.getState().status).toBe("rate-limited");
    expect(toasts).toEqual([]);
    err.mockRestore();
  });

  it("on a generic failure, pushes a 'couldn't load' toast and keeps connection", async () => {
    // A non-auth, non-rate-limit error (parse failure, transient
    // network blip) shouldn't tear down the session — just tell the
    // user the load failed.
    mocks.fetchAllPlaylists.mockRejectedValueOnce(new Error("parse"));
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    useSpotifyStore.setState({ connected: true, status: "connected" });
    await useSpotifyStore.getState().loadPlaylists("cid");
    expect(useSpotifyStore.getState().connected).toBe(true);
    expect(useSpotifyStore.getState().status).toBe("connected");
    expect(toasts).toEqual([
      { kind: "error", message: "Couldn't load Spotify playlists" },
    ]);
    err.mockRestore();
  });
});

describe("disconnect", () => {
  it("clears user, playlists, and connected; parks status at 'disconnected'", async () => {
    // disconnect() always parks status at "disconnected" — it does
    // NOT try to derive "unconfigured" from settings. The next
    // refreshConnection() call is the one that re-evaluates the
    // clientId and may flip to "unconfigured" if the user cleared it.
    mocks.getValidAccessToken.mockResolvedValue("tok");
    mocks.fetchCurrentUser.mockResolvedValue({ id: "u1", country: "US" });
    await useSpotifyStore.getState().refreshConnection("client-id");
    useSpotifyStore.setState({
      playlists: [{ id: "p1", name: "x", ownerId: "u1" }],
    });

    useSpotifyStore.getState().disconnect();
    const state = useSpotifyStore.getState();
    expect(state.connected).toBe(false);
    expect(state.user).toBeNull();
    expect(state.playlists).toEqual([]);
    expect(state.status).toBe("disconnected");
  });

  it("invokes the auth-layer disconnect to clear stored tokens", async () => {
    // disconnect() must propagate to the auth layer so PKCE / token
    // localStorage gets wiped. Otherwise a "Disconnect" then page
    // refresh would silently reconnect the user from cached tokens.
    useSpotifyStore.getState().disconnect();
    expect(mocks.disconnectFromSpotify).toHaveBeenCalledTimes(1);
  });
});

describe("setState / subscribe — basic setter & notify wiring", () => {
  it("setState({ user }) updates state and fires subscribers", () => {
    // Zustand's primitive setState is how callers (and the actions
    // above) write `user`. A subscribe() listener fires on each write,
    // which is what selector-based React reads ride on.
    const seen: Array<{ id: string } | null> = [];
    const unsubscribe = useSpotifyStore.subscribe((state) => {
      seen.push(state.user);
    });

    useSpotifyStore.setState({ user: { id: "u1", displayName: "A" } });
    useSpotifyStore.setState({ user: { id: "u2" } });
    expect(useSpotifyStore.getState().user).toEqual({ id: "u2" });

    // After unsubscribe, further writes must NOT call the listener.
    unsubscribe();
    useSpotifyStore.setState({ user: { id: "u3" } });

    expect(seen).toEqual([
      { id: "u1", displayName: "A" },
      { id: "u2" },
    ]);
  });

  it("setState({ status }) updates state and fires subscribers", () => {
    // The bootstrap reads `status` to decide whether to redirect into
    // OAuth, so a subscribe-driven re-read must see the new value
    // immediately after the write.
    const seen: string[] = [];
    const unsubscribe = useSpotifyStore.subscribe((state) => {
      seen.push(state.status);
    });

    useSpotifyStore.setState({ status: "connected" });
    useSpotifyStore.setState({ status: "rate-limited" });
    useSpotifyStore.setState({ status: "disconnected" });
    unsubscribe();

    expect(useSpotifyStore.getState().status).toBe("disconnected");
    expect(seen).toEqual(["connected", "rate-limited", "disconnected"]);
  });
});
