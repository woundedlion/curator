// Mock-fetch coverage of the Cover Art Archive probe surface.
//
// The probe boundary has three responsibilities that need to be pinned
// down so a refactor can't quietly regress them:
//   1. Tri-state result discrimination (ok / missing / transient) — the
//      runner relies on this to tell "no art exists" from "try again
//      later"; collapsing them silently drops art that *should* resolve.
//   2. Hydrate-once + negative-cache short-circuit — a freshly imported
//      1k-track library would otherwise re-probe the same known-404
//      releases on every reload and burn CAA's rate budget.
//   3. AbortError silence — our own timeout firing must not pollute the
//      console as a "network error" and confuse a debug session.
//
// Module-level state in coverArt.ts (the singleton hydrate promise and
// the in-memory negative cache) makes module isolation matter — each
// test that needs a fresh negativeCache uses vi.resetModules() and a
// dynamic import so the singleton starts empty.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { COVER_ART_BASE } from "../constants";

// Hoisted mock surface for the IDB layer. Tests poke
// `loadCoverArtNegativeCacheMock` to seed initial state and assert on
// `saveCoverArtNegativeMbidsMock` calls to verify persistence. The
// inline factory closes over these via the top-level `vi.hoisted` shim.
const dbMocks = vi.hoisted(() => ({
  loadCoverArtNegativeCache: vi.fn<() => Promise<string[]>>(async () => []),
  saveCoverArtNegativeMbids: vi.fn<(mbids: string[]) => Promise<void>>(
    async () => undefined,
  ),
}));

vi.mock("../db/musicbrainzCache", () => ({
  loadCoverArtNegativeCache: dbMocks.loadCoverArtNegativeCache,
  saveCoverArtNegativeMbids: dbMocks.saveCoverArtNegativeMbids,
}));

const RELEASE_A = "11111111-1111-1111-1111-111111111111";
const RELEASE_B = "22222222-2222-2222-2222-222222222222";
const RELEASE_C = "33333333-3333-3333-3333-333333333333";

function frontUrl(releaseId: string): string {
  return `${COVER_ART_BASE}/${releaseId}/front-250`;
}

function head200(): Response {
  return new Response(null, { status: 200 });
}

function head404(): Response {
  return new Response(null, { status: 404 });
}

function head503(): Response {
  return new Response(null, { status: 503 });
}

// Each test loads a freshly-isolated coverArt module so the singleton
// negativeCache / hydratePromise start empty. Helper centralizes the
// dance so individual tests stay focused on behavior.
async function loadFreshCoverArt() {
  vi.resetModules();
  return await import("./coverArt");
}

beforeEach(() => {
  dbMocks.loadCoverArtNegativeCache.mockReset();
  dbMocks.loadCoverArtNegativeCache.mockImplementation(async () => []);
  dbMocks.saveCoverArtNegativeMbids.mockReset();
  dbMocks.saveCoverArtNegativeMbids.mockImplementation(async () => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("coverArtUrlForRelease", () => {
  it("builds the canonical /front-250 URL for a given release mbid", async () => {
    // The runner stores the URL on the track regardless of whether the
    // probe has resolved yet, so the formatter must be stable and not
    // depend on any module state.
    const mod = await loadFreshCoverArt();
    expect(mod.coverArtUrlForRelease(RELEASE_A)).toBe(
      `${COVER_ART_BASE}/${RELEASE_A}/front-250`,
    );
  });

  it("returns undefined for an undefined or empty release mbid", async () => {
    // Many tracks come in without a release id; the formatter must
    // pass through cleanly rather than building a malformed URL like
    // ".../release//front-250".
    const mod = await loadFreshCoverArt();
    expect(mod.coverArtUrlForRelease(undefined)).toBeUndefined();
    expect(mod.coverArtUrlForRelease("")).toBeUndefined();
  });
});

describe("probeCoverArtUrl — tri-state result", () => {
  it("HEAD 200 → { kind: 'ok', url } with the canonical front-250 URL", async () => {
    // The runner uses the returned URL verbatim to populate the track;
    // a 200 must carry the URL it just verified, not undefined.
    const mod = await loadFreshCoverArt();
    const fetchSpy = vi
      .spyOn(global, "fetch")
      .mockResolvedValue(head200());

    const result = await mod.probeCoverArtUrl(RELEASE_A);

    expect(result).toEqual({ kind: "ok", url: frontUrl(RELEASE_A) });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchSpy.mock.calls[0]!;
    expect(calledUrl).toBe(frontUrl(RELEASE_A));
    expect((init as RequestInit | undefined)?.method).toBe("HEAD");
  });

  it("HEAD 404 → { kind: 'missing' } AND persists the mbid to the negative cache", async () => {
    // 404 is a stable "no front art exists" signal. Persisting it stops
    // a later re-enrich from re-probing the same dead release.
    const mod = await loadFreshCoverArt();
    vi.spyOn(global, "fetch").mockResolvedValue(head404());

    const result = await mod.probeCoverArtUrl(RELEASE_A);

    expect(result).toEqual({ kind: "missing" });
    // Persistence is fire-and-forget; flush microtasks so the .catch()
    // chain attaches before the test ends.
    await Promise.resolve();
    expect(dbMocks.saveCoverArtNegativeMbids).toHaveBeenCalledWith([
      RELEASE_A,
    ]);
  });

  it("HEAD 5xx → { kind: 'transient' } and does NOT touch the negative cache", async () => {
    // 5xx is upstream blip, not a missing-art signal. Caching it would
    // suppress real cover art the next time the host recovers.
    const mod = await loadFreshCoverArt();
    vi.spyOn(global, "fetch").mockResolvedValue(head503());
    // Silence the "transient failure" console.warn — it's expected.
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const result = await mod.probeCoverArtUrl(RELEASE_A);

    expect(result).toEqual({ kind: "transient" });
    await Promise.resolve();
    expect(dbMocks.saveCoverArtNegativeMbids).not.toHaveBeenCalled();
  });

  it("network error (fetch throws TypeError) → { kind: 'transient' }, no negative-cache write", async () => {
    // Offline / DNS / CORS preflight failure all surface as a thrown
    // TypeError. Treat identical to 5xx — transient, retryable.
    const mod = await loadFreshCoverArt();
    vi.spyOn(global, "fetch").mockRejectedValue(new TypeError("Failed to fetch"));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const result = await mod.probeCoverArtUrl(RELEASE_A);

    expect(result).toEqual({ kind: "transient" });
    await Promise.resolve();
    expect(dbMocks.saveCoverArtNegativeMbids).not.toHaveBeenCalled();
  });

  it("undefined releaseMbid → { kind: 'missing' } without touching fetch", async () => {
    // Without an id there's nothing to probe; the runner expects the
    // missing kind so it can move on (no transient retry).
    const mod = await loadFreshCoverArt();
    const fetchSpy = vi.spyOn(global, "fetch");

    expect(await mod.probeCoverArtUrl(undefined)).toEqual({ kind: "missing" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("AbortError filter", () => {
  it("a fetch rejection with name 'AbortError' is silent — does NOT log to console", async () => {
    // The probe's own 5s timeout aborts via AbortController. Logging
    // that as a "network error" lies about the cause and clutters debug
    // sessions during a re-enrich-all on a flaky network.
    const mod = await loadFreshCoverArt();
    const abortError = new Error("aborted");
    abortError.name = "AbortError";
    vi.spyOn(global, "fetch").mockRejectedValue(abortError);
    const warnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);

    const result = await mod.probeCoverArtUrl(RELEASE_A);

    expect(result).toEqual({ kind: "transient" });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("a non-AbortError rejection IS logged (so real failures stay visible)", async () => {
    // Mirror of the above — the silence must be scoped to aborts only.
    // A generic TypeError must still surface in the console.
    const mod = await loadFreshCoverArt();
    vi.spyOn(global, "fetch").mockRejectedValue(
      new TypeError("Failed to fetch"),
    );
    const warnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);

    await mod.probeCoverArtUrl(RELEASE_A);

    expect(warnSpy).toHaveBeenCalled();
  });
});

describe("hydrate-once promise singleton", () => {
  it("N concurrent probes share a single loadCoverArtNegativeCache call", async () => {
    // Without singleton-ing the hydrate promise, every concurrent
    // caller in a re-enrich-all burst would race to read IDB. This is
    // the test that catches a regression to per-call hydration.
    const mod = await loadFreshCoverArt();
    vi.spyOn(global, "fetch").mockResolvedValue(head200());

    await Promise.all([
      mod.probeCoverArtUrl(RELEASE_A),
      mod.probeCoverArtUrl(RELEASE_B),
      mod.probeCoverArtUrl(RELEASE_C),
    ]);

    expect(dbMocks.loadCoverArtNegativeCache).toHaveBeenCalledTimes(1);
  });

  it("after the first probe resolves, later probes do NOT re-hit IDB", async () => {
    // The negative cache is hydrated lazily on first probe and then
    // kept resident. A sequential second probe must reuse the resident
    // Set, not re-await the loader.
    const mod = await loadFreshCoverArt();
    vi.spyOn(global, "fetch").mockResolvedValue(head200());

    await mod.probeCoverArtUrl(RELEASE_A);
    await mod.probeCoverArtUrl(RELEASE_B);

    expect(dbMocks.loadCoverArtNegativeCache).toHaveBeenCalledTimes(1);
  });

  it("loadCoverArtNegativeCache rejection is swallowed — probes still resolve normally", async () => {
    // A corrupt IDB blob would otherwise wedge every probe. The runner
    // expects degraded operation (re-probe everything), not total
    // failure of the cover-art subsystem.
    dbMocks.loadCoverArtNegativeCache.mockRejectedValueOnce(
      new Error("idb unavailable"),
    );
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const mod = await loadFreshCoverArt();
    vi.spyOn(global, "fetch").mockResolvedValue(head200());

    const result = await mod.probeCoverArtUrl(RELEASE_A);
    expect(result).toEqual({ kind: "ok", url: frontUrl(RELEASE_A) });
  });
});

describe("negative cache short-circuit", () => {
  it("a release already in the persisted negative cache returns 'missing' WITHOUT fetching", async () => {
    // The whole point of persisting 404s: a reload re-hydrates the set
    // and re-probes never reach the network for known-dead releases.
    dbMocks.loadCoverArtNegativeCache.mockResolvedValueOnce([RELEASE_A]);
    const mod = await loadFreshCoverArt();
    const fetchSpy = vi.spyOn(global, "fetch");

    const result = await mod.probeCoverArtUrl(RELEASE_A);

    expect(result).toEqual({ kind: "missing" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a 404 result poisons the cache for the same id within the session", async () => {
    // First probe goes to the network and returns missing; the SECOND
    // probe in the same session must short-circuit on the in-memory
    // set even before IDB persistence settles.
    const mod = await loadFreshCoverArt();
    const fetchSpy = vi
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(head404());

    const first = await mod.probeCoverArtUrl(RELEASE_A);
    const second = await mod.probeCoverArtUrl(RELEASE_A);

    expect(first).toEqual({ kind: "missing" });
    expect(second).toEqual({ kind: "missing" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("REGRESSION: an in-session 404 recorded DURING hydration survives the IDB union (not lost)", async () => {
    // The bug: `negativeCache` started null and was REPLACED with the
    // IDB snapshot on hydration. A 404 recorded in the hydration window
    // persisted to IDB but vanished from memory the moment the snapshot
    // overwrote the Set — so the same dead release re-probed later in
    // the session. The fix initializes an empty Set up front and UNIONs
    // the IDB ids on hydration. This test holds hydration open, records
    // a 404 for RELEASE_A while it's pending, then resolves hydration
    // with a DISJOINT id (RELEASE_B). Afterward a re-probe of RELEASE_A
    // must short-circuit (in-memory 404 survived) AND RELEASE_B must
    // short-circuit (IDB id was merged in).
    let resolveLoad: (ids: string[]) => void = () => undefined;
    dbMocks.loadCoverArtNegativeCache.mockImplementationOnce(
      () =>
        new Promise<string[]>((resolve) => {
          resolveLoad = resolve;
        }),
    );
    const mod = await loadFreshCoverArt();
    const fetchSpy = vi
      .spyOn(global, "fetch")
      // First probe (RELEASE_A) 404s while hydration is still pending.
      .mockResolvedValueOnce(head404());

    // Kick off the first probe; it awaits ensureHydrated (still pending)
    // — but the 404 path records into the live in-memory Set regardless.
    const firstProbe = mod.probeCoverArtUrl(RELEASE_A);
    // Let the probe reach (and block on) ensureHydrated.
    await Promise.resolve();
    // Resolve hydration with a DISJOINT id so we can tell union from
    // replace: if the code replaced the Set, RELEASE_A would be lost.
    resolveLoad([RELEASE_B]);
    expect(await firstProbe).toEqual({ kind: "missing" });

    // Re-probe both. Neither should hit the network: RELEASE_A from the
    // surviving in-session 404, RELEASE_B from the merged IDB id.
    const a2 = await mod.probeCoverArtUrl(RELEASE_A);
    const b2 = await mod.probeCoverArtUrl(RELEASE_B);
    expect(a2).toEqual({ kind: "missing" });
    expect(b2).toEqual({ kind: "missing" });
    // Only the single initial HEAD (for the first RELEASE_A probe).
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("REGRESSION: the in-memory set respects the cap after a large hydration", async () => {
    // The bug: ensureHydrated unioned up to 10k persisted ids on top of
    // in-session ids WITHOUT re-applying the in-memory cap, and
    // recordNegative only evicted one entry per add (assuming a
    // single-entry overshoot). So right after hydrating a full persisted
    // set the in-memory Set could sit ABOVE the cap and only drain one id
    // per subsequent 404. The fix trims to the cap after the union. We
    // verify the invariant via its observable effect: hydrate with
    // CAP+1 ids; the oldest (mbids[0], inserted first) must have been
    // evicted, so re-probing it hits the network again, while a recent id
    // still short-circuits without fetching.
    const CAP = 10_000;
    const overflow = Array.from(
      { length: CAP + 1 },
      // Valid-shaped 36-char-ish ids; exact format doesn't matter to the
      // Set, only insertion order does.
      (_, i) => `cap-${String(i).padStart(8, "0")}`,
    );
    dbMocks.loadCoverArtNegativeCache.mockResolvedValueOnce(overflow);
    const mod = await loadFreshCoverArt();
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(head200());

    // The newest id is within the cap window → short-circuits (missing),
    // no network call.
    const newest = await mod.probeCoverArtUrl(overflow[CAP]);
    expect(newest).toEqual({ kind: "missing" });
    expect(fetchSpy).not.toHaveBeenCalled();

    // The oldest id was trimmed by the post-hydration cap enforcement →
    // it is no longer resident, so the probe falls through to the network.
    const oldest = await mod.probeCoverArtUrl(overflow[0]);
    expect(oldest).toEqual({ kind: "ok", url: frontUrl(overflow[0]!) });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("a transient failure does NOT poison the cache — a retry can still succeed", async () => {
    // Mirror of the previous test: 5xx is retryable, so the second
    // probe must actually hit the network again and (in this case)
    // succeed when CAA recovers.
    const mod = await loadFreshCoverArt();
    const fetchSpy = vi
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(head503())
      .mockResolvedValueOnce(head200());
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const first = await mod.probeCoverArtUrl(RELEASE_A);
    const second = await mod.probeCoverArtUrl(RELEASE_A);

    expect(first).toEqual({ kind: "transient" });
    expect(second).toEqual({ kind: "ok", url: frontUrl(RELEASE_A) });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("persistence failure (saveCoverArtNegativeMbids rejects) does not break the probe path", async () => {
    // The persistence write is intentionally fire-and-forget. A failure
    // here only costs us a re-probe after reload, never a runtime
    // exception. This locks that policy in.
    dbMocks.saveCoverArtNegativeMbids.mockRejectedValueOnce(
      new Error("idb write failed"),
    );
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const mod = await loadFreshCoverArt();
    vi.spyOn(global, "fetch").mockResolvedValue(head404());

    const result = await mod.probeCoverArtUrl(RELEASE_A);
    expect(result).toEqual({ kind: "missing" });
    // Flush the fire-and-forget chain so the .catch() resolves before
    // afterEach restores the console spy.
    await Promise.resolve();
    await Promise.resolve();
  });
});

describe("probe URL contract", () => {
  it("hits coverartarchive.org at /release/{id}/front-250 with a HEAD request", async () => {
    // Exact URL + method are part of the wire contract with CAA; a
    // GET would pull the image body unnecessarily, and the wrong path
    // would always 404. Pin both.
    const mod = await loadFreshCoverArt();
    const fetchSpy = vi
      .spyOn(global, "fetch")
      .mockResolvedValue(head200());

    await mod.probeCoverArtUrl(RELEASE_A);

    const [calledUrl, init] = fetchSpy.mock.calls[0]!;
    expect(calledUrl).toBe(
      `https://coverartarchive.org/release/${RELEASE_A}/front-250`,
    );
    expect((init as RequestInit | undefined)?.method).toBe("HEAD");
    expect((init as RequestInit | undefined)?.signal).toBeInstanceOf(
      AbortSignal,
    );
  });
});

describe("concurrency limiter (4 in-flight)", () => {
  it("never has more than 4 HEAD probes in flight at once", async () => {
    // CAA is hosted on archive.org; the limiter is the only thing
    // stopping a 1k-row ingest from firing 1k parallel HEADs. If the
    // limit constant or its wiring regresses, this test catches it.
    const mod = await loadFreshCoverArt();

    let inFlight = 0;
    let maxInFlight = 0;
    type Resolver = (response: Response) => void;
    const pending: Resolver[] = [];

    vi.spyOn(global, "fetch").mockImplementation(() => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      return new Promise<Response>((resolve) => {
        pending.push((response) => {
          inFlight--;
          resolve(response);
        });
      });
    });

    // Kick off 10 concurrent probes against distinct ids so the
    // negative cache can't short-circuit any of them.
    const ids = Array.from(
      { length: 10 },
      (_, i) => `aaaaaaaa-aaaa-aaaa-aaaa-${String(i).padStart(12, "0")}`,
    );
    const probes = ids.map((id) => mod.probeCoverArtUrl(id));

    // Let the limiter admit the first batch. Each probe must first
    // clear the async ensureHydrated() hop before reaching the
    // limiter, so flush several microtask turns to be safe.
    for (let i = 0; i < 20; i++) await Promise.resolve();

    expect(maxInFlight).toBe(4);
    expect(inFlight).toBe(4);

    // Drain in waves to confirm the limiter releases slots one-for-one
    // as tasks resolve and never exceeds 4.
    while (pending.length > 0) {
      const resolver = pending.shift()!;
      resolver(head200());
      for (let i = 0; i < 10; i++) await Promise.resolve();
      expect(inFlight).toBeLessThanOrEqual(4);
    }

    const results = await Promise.all(probes);
    expect(results).toHaveLength(10);
    expect(maxInFlight).toBe(4);
  });
});
