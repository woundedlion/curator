// @vitest-environment happy-dom
//
// Tests for the auth/refresh flow — the security- and correctness-
// critical path the original review flagged as essentially untested.
// Covers: completeAuthFlow's CSRF (state-mismatch) rejection + PKCE key
// cleanup, refreshAccessToken's transient-5xx vs. fatal-4xx branching,
// and getValidAccessToken's single-flight de-duplication (keyed on
// clientId).
//
// The rate-limit wrapper (`runWithRateLimitPolicy`) is overridden to call
// the send callback directly so the real IntervalQueue/CircuitBreaker
// timing doesn't enter the picture; the typed error classes stay real so
// `instanceof` assertions are meaningful. tokenStorage runs for real
// against happy-dom's sessionStorage.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PKCE_STATE_KEY, PKCE_VERIFIER_KEY } from "../constants";
import type * as ApiClientModule from "./apiClient";

vi.mock("./apiClient", async () => {
  const actual = await vi.importActual<typeof ApiClientModule>("./apiClient");
  return {
    ...actual,
    // Pass straight through to the send callback — no queue, no breaker.
    runWithRateLimitPolicy: (send: () => Promise<Response>) => send(),
  };
});

import {
  beginAuthFlow,
  completeAuthFlow,
  getValidAccessToken,
  InvalidRedirectUriError,
  MissingRefreshTokenError,
} from "./authFlow";
import {
  SpotifyAuthExpiredError,
  SpotifyServerError,
} from "./apiClient";
import { readTokens, writeTokens } from "./tokenStorage";
import type { SpotifyTokens } from "../types";

function expiredTokens(): SpotifyTokens {
  return {
    accessToken: "old-access",
    refreshToken: "refresh-1",
    expiresAt: Date.now() - 1000, // already past the freshness guard
    scope: "playlist-modify-public",
  };
}

function tokenResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  sessionStorage.clear();
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("completeAuthFlow — CSRF / key hygiene", () => {
  it("rejects on a state mismatch and clears both PKCE keys", async () => {
    sessionStorage.setItem(PKCE_STATE_KEY, "real-state");
    sessionStorage.setItem(PKCE_VERIFIER_KEY, "verifier-xyz");
    await expect(
      completeAuthFlow("client-1", "https://app/redirect", {
        code: "auth-code",
        state: "FORGED-state",
      }),
    ).rejects.toThrow("PKCE state mismatch");
    // A suspect verifier must never survive for a replay.
    expect(sessionStorage.getItem(PKCE_STATE_KEY)).toBeNull();
    expect(sessionStorage.getItem(PKCE_VERIFIER_KEY)).toBeNull();
  });

  it("rejects when the PKCE keys are missing entirely", async () => {
    await expect(
      completeAuthFlow("client-1", "https://app/redirect", {
        code: "auth-code",
        state: "whatever",
      }),
    ).rejects.toThrow("Missing PKCE state");
  });

  it("fails loudly (does NOT persist empty-string refresh) when the initial exchange returns no refresh_token", async () => {
    // The exact silent-logout bug: an initial code exchange that omits
    // refresh_token must throw a typed error rather than storing
    // refreshToken: "" — which would 400 on the next refresh and log the
    // user out with no explanation.
    sessionStorage.setItem(PKCE_STATE_KEY, "state-1");
    sessionStorage.setItem(PKCE_VERIFIER_KEY, "verifier-1");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        tokenResponse({
          access_token: "access-no-refresh",
          // refresh_token deliberately absent
          expires_in: 3600,
          scope: "playlist-modify-public",
          token_type: "Bearer",
        }),
      ),
    );
    const error = await completeAuthFlow(
      "client-1",
      "https://app/redirect",
      { code: "auth-code", state: "state-1" },
    ).catch((e) => e);
    expect(error).toBeInstanceOf(MissingRefreshTokenError);
    // Nothing persisted — no empty-string sentinel left behind.
    expect(readTokens()).toBeNull();
    // PKCE keys cleared on the failed exchange.
    expect(sessionStorage.getItem(PKCE_STATE_KEY)).toBeNull();
    expect(sessionStorage.getItem(PKCE_VERIFIER_KEY)).toBeNull();
  });

  it("succeeds on the initial exchange when a refresh_token IS present", async () => {
    sessionStorage.setItem(PKCE_STATE_KEY, "state-1");
    sessionStorage.setItem(PKCE_VERIFIER_KEY, "verifier-1");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        tokenResponse({
          access_token: "access-1",
          refresh_token: "refresh-initial",
          expires_in: 3600,
          scope: "playlist-modify-public",
          token_type: "Bearer",
        }),
      ),
    );
    const tokens = await completeAuthFlow("client-1", "https://app/redirect", {
      code: "auth-code",
      state: "state-1",
    });
    expect(tokens.refreshToken).toBe("refresh-initial");
    expect(readTokens()?.refreshToken).toBe("refresh-initial");
  });
});

describe("redirect-URI validation at the auth boundary", () => {
  it("beginAuthFlow rejects a non-absolute / non-http(s) redirect URI before redirecting", async () => {
    // spotifyRedirectUri is user-editable free text; a malformed value
    // must throw a typed error the UI can surface rather than bounce the
    // user to a broken authorize URL.
    const assignSpy = vi.fn();
    vi.stubGlobal("location", { assign: assignSpy } as unknown as Location);
    for (const bad of ["not a url", "ftp://app/redirect", "/relative/only", ""]) {
      await expect(
        beginAuthFlow("client-1", bad),
      ).rejects.toBeInstanceOf(InvalidRedirectUriError);
    }
    expect(assignSpy).not.toHaveBeenCalled();
  });

  it("beginAuthFlow accepts a well-formed http(s) redirect URI", async () => {
    const assignSpy = vi.fn();
    vi.stubGlobal("location", { assign: assignSpy } as unknown as Location);
    await beginAuthFlow("client-1", "https://app.example.com/callback");
    expect(assignSpy).toHaveBeenCalledTimes(1);
    const url = assignSpy.mock.calls[0]![0] as string;
    expect(url).toContain("redirect_uri=https%3A%2F%2Fapp.example.com%2Fcallback");
  });

  it("completeAuthFlow rejects a malformed redirect URI at the token-request boundary", async () => {
    sessionStorage.setItem(PKCE_STATE_KEY, "state-1");
    sessionStorage.setItem(PKCE_VERIFIER_KEY, "verifier-1");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      completeAuthFlow("client-1", "not-a-url", {
        code: "auth-code",
        state: "state-1",
      }),
    ).rejects.toBeInstanceOf(InvalidRedirectUriError);
    // Never hit the token endpoint with a bad redirect URI.
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("getValidAccessToken — refresh branching", () => {
  it("returns the cached access token without refreshing when it is still fresh", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    writeTokens({
      accessToken: "fresh-access",
      refreshToken: "r",
      expiresAt: Date.now() + 60 * 60 * 1000,
      scope: "playlist-modify-public",
    });
    await expect(getValidAccessToken("client-1")).resolves.toBe("fresh-access");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("on a 200 refresh: returns the new token and persists it", async () => {
    writeTokens(expiredTokens());
    const fetchMock = vi.fn(async () =>
      tokenResponse({
        access_token: "new-access",
        refresh_token: "refresh-2",
        expires_in: 3600,
        scope: "playlist-modify-public",
        token_type: "Bearer",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(getValidAccessToken("client-1")).resolves.toBe("new-access");
    expect(readTokens()?.accessToken).toBe("new-access");
    expect(readTokens()?.refreshToken).toBe("refresh-2");
  });

  it("on a transient 5xx refresh: throws SpotifyServerError(/api/token) and does NOT clear tokens", async () => {
    writeTokens(expiredTokens());
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("upstream down", { status: 503 })),
    );
    const error = await getValidAccessToken("client-1").catch((e) => e);
    expect(error).toBeInstanceOf(SpotifyServerError);
    expect((error as SpotifyServerError).path).toBe("/api/token");
    // A flake must not log the user out — the refresh token survives.
    expect(readTokens()?.refreshToken).toBe("refresh-1");
  });

  it("on a fatal 4xx refresh: throws SpotifyAuthExpiredError and clears tokens", async () => {
    writeTokens(expiredTokens());
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("invalid_grant", { status: 400 })),
    );
    const error = await getValidAccessToken("client-1").catch((e) => e);
    expect(error).toBeInstanceOf(SpotifyAuthExpiredError);
    expect(readTokens()).toBeNull();
  });

  it("throws SpotifyAuthExpiredError immediately when there are no tokens at all", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(getValidAccessToken("client-1")).rejects.toBeInstanceOf(
      SpotifyAuthExpiredError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("single-flight: two concurrent calls for the same client trigger exactly one refresh", async () => {
    writeTokens(expiredTokens());
    const fetchMock = vi.fn(async () =>
      tokenResponse({
        access_token: "shared-access",
        refresh_token: "refresh-2",
        expires_in: 3600,
        scope: "playlist-modify-public",
        token_type: "Bearer",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const [a, b] = await Promise.all([
      getValidAccessToken("client-1"),
      getValidAccessToken("client-1"),
    ]);
    expect(a).toBe("shared-access");
    expect(b).toBe("shared-access");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
