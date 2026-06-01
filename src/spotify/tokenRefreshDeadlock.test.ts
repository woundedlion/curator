// @vitest-environment happy-dom
//
// Regression: the Spotify token-refresh deadlock.
//
// Every Spotify API call and every OAuth token refresh used to share one
// serial rate-limit queue (one task in flight at a time, awaited to
// completion before the next starts). A normal API request, while it is the
// running task, calls getValidAccessToken — which, on an expired token,
// enqueues a SECOND task (the token POST) into the same queue. That second
// task can't start until the first finishes; the first can't finish until the
// second resolves. Circular wait → the queue wedges for the life of the tab.
// It fires on the first API call made after the access token expires (~hourly).
//
// Every OTHER Spotify suite stubs getValidAccessToken to a constant, so the
// nested-enqueue path never runs against the real queue and the bug stays
// invisible. This suite is the opposite: REAL getValidAccessToken + REAL
// IntervalQueue + REAL CircuitBreaker, mocking ONLY global fetch, with an
// already-expired token in storage — exactly the production shape. On the
// buggy code these tests hang to the vitest timeout; fixed, they resolve in
// milliseconds.
//
// Real timers on purpose: a fresh queue's nextRunAt is 0, so requests fire
// immediately and a correct refresh completes in a couple of microtask turns.
// A deadlock cannot be "advanced" past with fake timers — it's the absence of
// progress — so we let the real default test timeout be the failure signal.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SPOTIFY_SCOPES } from "../constants";
import {
  submitSpotifyRequest,
  __resetSpotifyRateLimitStateForTests,
} from "./apiClient";
import { writeTokens } from "./tokenStorage";
import type { SpotifyTokens } from "../types";

function expiredTokens(): SpotifyTokens {
  return {
    accessToken: "stale-access",
    refreshToken: "refresh-1",
    expiresAt: Date.now() - 1000, // already past the freshness guard
    scope: "playlist-modify-public",
  };
}

function tokenRefreshResponse(): Response {
  return new Response(
    JSON.stringify({
      access_token: "fresh-access",
      refresh_token: "refresh-1",
      expires_in: 3600,
      // Full scope set — getValidAccessToken now re-validates the
      // refreshed token's scopes and rejects a narrowed grant.
      scope: SPOTIFY_SCOPES,
      token_type: "Bearer",
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function apiResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  __resetSpotifyRateLimitStateForTests();
  writeTokens(expiredTokens());
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Spotify token-refresh deadlock (real queue + real getValidAccessToken)", () => {
  it("an API call made after the access token expired refreshes and resolves", async () => {
    const fetchMock = vi.fn(async (url: string | URL, _init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/api/token")) return tokenRefreshResponse();
      return apiResponse({ id: "u1" });
    });
    vi.stubGlobal("fetch", fetchMock);

    // On the buggy code this never resolves (the refresh task can't run
    // while the API task holds the single in-flight slot and awaits it).
    const result = await submitSpotifyRequest<{ id: string }>(
      { path: "/me" },
      "client-1",
    );

    expect(result).toEqual({ id: "u1" });

    // The token POST went out, followed by the API GET carrying the
    // freshly-minted bearer.
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes("/api/token"))).toBe(true);
    expect(urls.some((u) => u.includes("/me"))).toBe(true);

    // The refresh persisted the new access token (so subsequent calls
    // skip the refresh path).
    const apiCall = fetchMock.mock.calls.find((c) =>
      String(c[0]).includes("/me"),
    );
    const headers = (apiCall?.[1]?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer fresh-access");
  });

  it("two concurrent API calls after expiry both resolve (no wedge)", async () => {
    let tokenPosts = 0;
    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes("/api/token")) {
        tokenPosts++;
        return tokenRefreshResponse();
      }
      return apiResponse({ ok: u });
    });
    vi.stubGlobal("fetch", fetchMock);

    const [a, b] = await Promise.all([
      submitSpotifyRequest<{ ok: string }>({ path: "/a" }, "client-1"),
      submitSpotifyRequest<{ ok: string }>({ path: "/b" }, "client-1"),
    ]);

    expect(a.ok).toContain("/a");
    expect(b.ok).toContain("/b");
    // Exactly one token POST: the queue is serial, so by the time the
    // second API task runs the first has already refreshed and persisted
    // the token. (The deadlock would have wedged before either resolved.)
    expect(tokenPosts).toBe(1);
  });
});
