// @vitest-environment happy-dom
//
// Branch coverage for the Spotify bootstrap (services/spotifyBootstrap.ts),
// the most branch-heavy file in services. Every external dependency — the
// auth flow, token storage, and the settings/spotify/ui stores — is mocked
// so each branch can be driven deterministically.
//
// Branches covered:
//   - no clientId → early return (does nothing).
//   - OAuth callback error path: disconnect + markAutoReconnectSuppressed +
//     error toast, NO spurious "connect failed" toast, and a SUPPRESSED
//     auto-reconnect afterwards.
//   - successful token exchange (callback `code`, no prior tokens).
//   - scope-drift forcing a reconnect (missingScopes → disconnect).
//   - `rate-limited` status skips auto-reconnect (no beginAuthFlow).
//   - module-level `inflight` promise coalescing concurrent calls
//     (StrictMode double-mount): one doBootstrap run for two callers.
//   - loadPlaylists failure is contained (does NOT reject bootstrap).
//   - auto-reconnect (disconnected, not suppressed) → beginAuthFlow.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// localStorage polyfill in case a mocked module's transitive import reads
// it at init (apiClient pattern). happy-dom provides sessionStorage.
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

const mocks = vi.hoisted(() => ({
  // authFlow
  beginAuthFlow: vi.fn(async () => undefined),
  clearCallbackParams: vi.fn(),
  completeAuthFlow: vi.fn(async () => undefined),
  disconnectFromSpotify: vi.fn(),
  missingScopes: vi.fn(() => [] as string[]),
  readAuthCallback: vi.fn<() => unknown>(() => null),
  // tokenStorage
  readTokens: vi.fn<() => unknown>(() => null),
  // stores
  settings: {
    spotifyClientId: "client-123" as string | undefined,
    spotifyRedirectUri: "https://app.test/callback",
  },
  refreshConnection: vi.fn(async () => undefined),
  loadPlaylists: vi.fn(async () => undefined),
  connected: false,
  status: "disconnected" as string,
  pushToast: vi.fn(),
}));

vi.mock("../spotify/authFlow", () => ({
  beginAuthFlow: mocks.beginAuthFlow,
  clearCallbackParams: mocks.clearCallbackParams,
  completeAuthFlow: mocks.completeAuthFlow,
  disconnectFromSpotify: mocks.disconnectFromSpotify,
  missingScopes: mocks.missingScopes,
  readAuthCallback: mocks.readAuthCallback,
}));

vi.mock("../spotify/tokenStorage", () => ({
  readTokens: mocks.readTokens,
}));

vi.mock("../store/settingsStore", () => ({
  useSettingsStore: {
    getState: () => ({ settings: mocks.settings }),
  },
}));

vi.mock("../store/spotifyStore", () => ({
  useSpotifyStore: {
    getState: () => ({
      refreshConnection: mocks.refreshConnection,
      loadPlaylists: mocks.loadPlaylists,
      connected: mocks.connected,
      status: mocks.status,
    }),
  },
}));

vi.mock("../store/uiStore", () => ({
  useUiStore: {
    getState: () => ({ pushToast: mocks.pushToast }),
  },
}));

import { SPOTIFY_AUTO_RECONNECT_SUPPRESSED_KEY } from "../constants";
import {
  bootstrapSpotify,
  clearAutoReconnectSuppression,
  markAutoReconnectSuppressed,
} from "./spotifyBootstrap";

function resetMocks(): void {
  mocks.beginAuthFlow.mockReset().mockResolvedValue(undefined);
  mocks.clearCallbackParams.mockReset();
  mocks.completeAuthFlow.mockReset().mockResolvedValue(undefined);
  mocks.disconnectFromSpotify.mockReset();
  mocks.missingScopes.mockReset().mockReturnValue([]);
  mocks.readAuthCallback.mockReset().mockReturnValue(null);
  mocks.readTokens.mockReset().mockReturnValue(null);
  mocks.refreshConnection.mockReset().mockResolvedValue(undefined);
  mocks.loadPlaylists.mockReset().mockResolvedValue(undefined);
  mocks.pushToast.mockReset();
  mocks.settings = {
    spotifyClientId: "client-123",
    spotifyRedirectUri: "https://app.test/callback",
  };
  mocks.connected = false;
  mocks.status = "disconnected";
}

beforeEach(() => {
  sessionStorage.clear();
  resetMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("bootstrapSpotify — early returns", () => {
  it("does nothing when no clientId is configured", async () => {
    mocks.settings = {
      spotifyClientId: undefined,
      spotifyRedirectUri: "https://app.test/callback",
    };

    await bootstrapSpotify();

    expect(mocks.readAuthCallback).not.toHaveBeenCalled();
    expect(mocks.refreshConnection).not.toHaveBeenCalled();
  });
});

describe("bootstrapSpotify — OAuth callback error path", () => {
  it("disconnects, suppresses auto-reconnect, toasts the error, and clears params", async () => {
    mocks.readAuthCallback.mockReturnValue({
      kind: "error",
      error: "access_denied",
    });

    await bootstrapSpotify();

    expect(mocks.disconnectFromSpotify).toHaveBeenCalled();
    expect(
      sessionStorage.getItem(SPOTIFY_AUTO_RECONNECT_SUPPRESSED_KEY),
    ).toBe("1");
    expect(mocks.pushToast).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "error" }),
    );
    expect(mocks.clearCallbackParams).toHaveBeenCalled();
    // It returns BEFORE refreshConnection / auto-reconnect.
    expect(mocks.refreshConnection).not.toHaveBeenCalled();
    expect(mocks.beginAuthFlow).not.toHaveBeenCalled();
  });

  it("does not emit a spurious 'connect failed' toast on the error path", async () => {
    mocks.readAuthCallback.mockReturnValue({
      kind: "error",
      error: "invalid_scope",
    });

    await bootstrapSpotify();

    const messages = mocks.pushToast.mock.calls.map(
      (c) => (c[0] as { message: string }).message,
    );
    expect(messages.some((m) => /connect failed/i.test(m))).toBe(false);
  });
});

describe("bootstrapSpotify — successful token exchange", () => {
  it("completes the auth flow when a code callback arrives with no prior tokens", async () => {
    mocks.readAuthCallback.mockReturnValue({
      kind: "code",
      code: "the-code",
      state: "the-state",
    });
    // No tokens before exchange; tokens present after (connection established).
    mocks.readTokens
      .mockReturnValueOnce(null) // alreadyHasTokens check
      .mockReturnValue({ accessToken: "a", scope: "s" });
    mocks.connected = true;

    await bootstrapSpotify();

    expect(mocks.completeAuthFlow).toHaveBeenCalledWith(
      "client-123",
      "https://app.test/callback",
      { kind: "code", code: "the-code", state: "the-state" },
    );
    expect(mocks.clearCallbackParams).toHaveBeenCalled();
    expect(mocks.refreshConnection).toHaveBeenCalledWith("client-123");
    // Connected → playlists loaded, no error toast.
    expect(mocks.loadPlaylists).toHaveBeenCalledWith("client-123");
    expect(mocks.pushToast).not.toHaveBeenCalled();
  });

  it("does not re-exchange when tokens already exist for the code callback", async () => {
    mocks.readAuthCallback.mockReturnValue({
      kind: "code",
      code: "the-code",
      state: "the-state",
    });
    mocks.readTokens.mockReturnValue({ accessToken: "a", scope: "s" });
    mocks.connected = true;

    await bootstrapSpotify();

    expect(mocks.completeAuthFlow).not.toHaveBeenCalled();
  });

  it("contains a completeAuthFlow failure (tokens absent) with a connect-failed toast", async () => {
    mocks.readAuthCallback.mockReturnValue({
      kind: "code",
      code: "the-code",
      state: "the-state",
    });
    // No tokens before, none after the failed exchange.
    mocks.readTokens.mockReturnValue(null);
    mocks.completeAuthFlow.mockRejectedValue(new Error("exchange boom"));

    // Must not reject the bootstrap.
    await expect(bootstrapSpotify()).resolves.toBeUndefined();

    expect(mocks.disconnectFromSpotify).toHaveBeenCalled();
    expect(mocks.pushToast).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "error",
        message: expect.stringMatching(/connect failed/i),
      }),
    );
  });
});

describe("bootstrapSpotify — scope drift", () => {
  it("forces a reconnect (disconnect) when existing tokens are missing scopes", async () => {
    mocks.readAuthCallback.mockReturnValue(null);
    mocks.readTokens.mockReturnValue({ accessToken: "a", scope: "old" });
    mocks.missingScopes.mockReturnValue(["playlist-modify-public"]);
    mocks.connected = true;

    await bootstrapSpotify();

    expect(mocks.missingScopes).toHaveBeenCalled();
    expect(mocks.disconnectFromSpotify).toHaveBeenCalled();
  });

  it("does NOT disconnect when existing tokens carry all required scopes", async () => {
    mocks.readAuthCallback.mockReturnValue(null);
    mocks.readTokens.mockReturnValue({ accessToken: "a", scope: "all" });
    mocks.missingScopes.mockReturnValue([]);
    mocks.connected = true;

    await bootstrapSpotify();

    expect(mocks.disconnectFromSpotify).not.toHaveBeenCalled();
  });
});

describe("bootstrapSpotify — auto-reconnect gating", () => {
  it("skips auto-reconnect when the status is 'rate-limited'", async () => {
    mocks.readAuthCallback.mockReturnValue(null);
    mocks.connected = false;
    mocks.status = "rate-limited";

    await bootstrapSpotify();

    expect(mocks.beginAuthFlow).not.toHaveBeenCalled();
  });

  it("redirects via beginAuthFlow when disconnected and not suppressed", async () => {
    mocks.readAuthCallback.mockReturnValue(null);
    mocks.connected = false;
    mocks.status = "disconnected";

    await bootstrapSpotify();

    expect(mocks.beginAuthFlow).toHaveBeenCalledWith(
      "client-123",
      "https://app.test/callback",
    );
  });

  it("skips auto-reconnect when suppression flag is set", async () => {
    sessionStorage.setItem(SPOTIFY_AUTO_RECONNECT_SUPPRESSED_KEY, "1");
    mocks.readAuthCallback.mockReturnValue(null);
    mocks.connected = false;
    mocks.status = "disconnected";

    await bootstrapSpotify();

    expect(mocks.beginAuthFlow).not.toHaveBeenCalled();
  });

  it("contains a beginAuthFlow rejection with a retry toast (no escaping rejection)", async () => {
    mocks.readAuthCallback.mockReturnValue(null);
    mocks.connected = false;
    mocks.status = "disconnected";
    mocks.beginAuthFlow.mockRejectedValue(new Error("pkce boom"));

    await expect(bootstrapSpotify()).resolves.toBeUndefined();
    expect(mocks.pushToast).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "error" }),
    );
  });
});

describe("bootstrapSpotify — loadPlaylists failure is contained", () => {
  it("does not reject the bootstrap when loadPlaylists throws", async () => {
    mocks.readAuthCallback.mockReturnValue(null);
    mocks.connected = true;
    mocks.loadPlaylists.mockRejectedValue(new Error("paged fetch boom"));

    await expect(bootstrapSpotify()).resolves.toBeUndefined();
    expect(mocks.loadPlaylists).toHaveBeenCalled();
  });
});

describe("bootstrapSpotify — inflight coalescing (StrictMode double-mount)", () => {
  it("shares one doBootstrap run across concurrent callers", async () => {
    mocks.readAuthCallback.mockReturnValue(null);
    mocks.connected = true;
    // Make refreshConnection slow so both callers overlap on the same
    // inflight promise.
    let resolveRefresh!: (value: undefined) => void;
    mocks.refreshConnection.mockImplementation(
      () =>
        new Promise<undefined>((r) => {
          resolveRefresh = r;
        }),
    );

    const p1 = bootstrapSpotify();
    const p2 = bootstrapSpotify();
    expect(p1).toBe(p2); // same coalesced promise

    resolveRefresh(undefined);
    await Promise.all([p1, p2]);

    // refreshConnection / readAuthCallback ran exactly once despite two calls.
    expect(mocks.refreshConnection).toHaveBeenCalledTimes(1);
    expect(mocks.readAuthCallback).toHaveBeenCalledTimes(1);
  });

  it("starts a fresh run after the prior one settles", async () => {
    mocks.readAuthCallback.mockReturnValue(null);
    mocks.connected = true;

    await bootstrapSpotify();
    await bootstrapSpotify();

    expect(mocks.refreshConnection).toHaveBeenCalledTimes(2);
  });
});

describe("suppression helpers", () => {
  it("mark/clear toggle the sessionStorage flag", () => {
    markAutoReconnectSuppressed();
    expect(
      sessionStorage.getItem(SPOTIFY_AUTO_RECONNECT_SUPPRESSED_KEY),
    ).toBe("1");
    clearAutoReconnectSuppression();
    expect(
      sessionStorage.getItem(SPOTIFY_AUTO_RECONNECT_SUPPRESSED_KEY),
    ).toBeNull();
  });
});
