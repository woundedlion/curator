import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// localStorage polyfill — apiClient.ts is imported transitively
// (parseRetryAfter) and reads from localStorage at module init.
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

vi.mock("../store/uiStore", () => ({
  useUiStore: { getState: () => ({ pushToast: () => undefined }) },
}));

import {
  buildClientParam,
  buildPermissiveQuery,
  buildUserAgent,
  getMusicbrainzQueue,
  searchRecordings,
} from "./musicbrainzClient";
import { MUSICBRAINZ_RATE_INTERVAL_MS } from "../constants";

const CONTACT = "test@example.com";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function unavailable(retryAfter: string | null = "1"): Response {
  const headers = new Headers();
  if (retryAfter !== null) headers.set("Retry-After", retryAfter);
  return new Response("Service Unavailable", { status: 503, headers });
}

function captureRejection<T>(p: Promise<T>): Promise<unknown> {
  return p.then(
    () => new Error("expected rejection but promise resolved"),
    (reason) => reason,
  );
}

describe("buildPermissiveQuery", () => {
  it("strips Lucene field prefixes and quotes", () => {
    expect(
      buildPermissiveQuery('recording:"Karma Police" AND artist:"Radiohead"'),
    ).toBe("Karma Police Radiohead");
  });

  it("strips an escape pair before bare quotes (no orphan backslash)", () => {
    // Title with an embedded double-quote: She Said \"Yes\"
    expect(
      buildPermissiveQuery('recording:"She Said \\"Yes\\""'),
    ).toBe("She Said Yes");
  });

  it("preserves the literal word AND inside a title", () => {
    // Lucene's AND operator must have whitespace on both sides — the
    // word "AND" mid-token (e.g. "WALK AND DON'T LOOK BACK" used as a
    // title token) should survive.
    expect(buildPermissiveQuery('recording:"WALK AND DON\'T LOOK BACK"'))
      .toContain("WALK");
    expect(buildPermissiveQuery('recording:"WALK AND DON\'T LOOK BACK"'))
      .toContain("DON'T");
    expect(buildPermissiveQuery('recording:"WALK AND DON\'T LOOK BACK"'))
      .toContain("LOOK");
    expect(buildPermissiveQuery('recording:"WALK AND DON\'T LOOK BACK"'))
      .toContain("BACK");
  });

  it("strips the AND operator between clauses", () => {
    expect(
      buildPermissiveQuery("recording:Foo AND artist:Bar"),
    ).toBe("Foo Bar");
  });

  it("collapses whitespace", () => {
    expect(buildPermissiveQuery('  foo   bar    baz  ')).toBe("foo bar baz");
  });

  it("returns empty string for empty input", () => {
    expect(buildPermissiveQuery("")).toBe("");
  });
});

describe("buildClientParam", () => {
  it("uses dash-separated form acceptable to MB's client= param", () => {
    expect(buildClientParam("alice@example.com")).toMatch(
      /^Curator-\d/,
    );
  });

  it("sanitizes characters not allowed in the client param", () => {
    // The client= param expects [A-Za-z0-9._-] only — characters like @
    // would otherwise corrupt the URL encoding. They should be replaced
    // with an underscore so the value remains parseable.
    const value = buildClientParam("alice+bob@example.com");
    expect(value).not.toContain("@");
    expect(value).not.toContain("+");
    expect(value).toContain("alice");
    expect(value).toContain("example.com");
  });
});

describe("buildUserAgent", () => {
  it("uses the MB-recommended bracketed contact form", () => {
    expect(buildUserAgent("alice@example.com")).toBe(
      `Curator/0.1.0 ( alice@example.com )`,
    );
  });
});

// ---------------------------------------------------------------------------
// Mock-fetch coverage of the MusicBrainz client. Mirrors the Spotify
// rate-limit tests in shape: every external HTTP call is mocked, fake
// timers control the 1 req/sec queue, and we assert both request shape
// (User-Agent, client= param, dismax fallback) and response handling
// (503 retry-once, non-JSON body, recording → candidate mapping).
// ---------------------------------------------------------------------------

describe("searchRecordings (mocked fetch)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    // Reset the module-shared queue so cross-test `nextRunAt` doesn't
    // delay the first request of a new test.
    getMusicbrainzQueue().reset();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe("strict pass", () => {
    it("issues a GET against /ws/2/recording with the strict query and client= param", async () => {
      const fetchMock = vi.fn<typeof fetch>(async () =>
        jsonResponse({
          recordings: [
            {
              id: "rec-1",
              title: "Karma Police",
              "artist-credit": [{ name: "Radiohead" }],
              "first-release-date": "1997-05-21",
              releases: [
                { id: "rel-1", title: "OK Computer", date: "1997-05-21" },
              ],
            },
          ],
        }),
      );
      vi.stubGlobal("fetch", fetchMock);

      const p = searchRecordings(
        'recording:"Karma Police" AND artist:"Radiohead"',
        CONTACT,
      );
      await vi.advanceTimersByTimeAsync(0);
      const candidates = await p;

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const url = String(fetchMock.mock.calls[0][0]);
      expect(url).toContain("/ws/2/recording");
      expect(url).toContain("query=");
      expect(url).toContain("fmt=json");
      expect(url).toContain("client=");
      // Strict pass — dismax NOT set.
      expect(url).not.toContain("dismax=true");

      expect(candidates).toHaveLength(1);
      expect(candidates[0]).toMatchObject({
        recordingId: "rec-1",
        title: "Karma Police",
        artist: "Radiohead",
        album: "OK Computer",
        year: 1997,
      });
    });

    it("sends User-Agent and Accept headers", async () => {
      const fetchMock = vi.fn<typeof fetch>(async () =>
        jsonResponse({ recordings: [] }),
      );
      vi.stubGlobal("fetch", fetchMock);

      const p = searchRecordings('recording:"X" AND artist:"Y"', CONTACT);
      // strict + permissive both return [] → two requests, spaced.
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(MUSICBRAINZ_RATE_INTERVAL_MS);
      await p;

      const headers = fetchMock.mock.calls[0][1]?.headers as Record<
        string,
        string
      >;
      expect(headers["User-Agent"]).toContain("Curator/");
      expect(headers["User-Agent"]).toContain(CONTACT);
      expect(headers["Accept"]).toBe("application/json");
    });
  });

  describe("dismax fallback", () => {
    it("falls back to a permissive (dismax=true) query when strict returns 0", async () => {
      let callIndex = 0;
      const fetchMock = vi.fn<typeof fetch>(async () => {
        callIndex++;
        if (callIndex === 1) return jsonResponse({ recordings: [] });
        return jsonResponse({
          recordings: [
            {
              id: "rec-2",
              title: "Love Sponge",
              "artist-credit": [{ name: "Sublime" }],
            },
          ],
        });
      });
      vi.stubGlobal("fetch", fetchMock);

      const p = searchRecordings(
        'recording:"Lovesponge" AND artist:"Sublime"',
        CONTACT,
      );
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(MUSICBRAINZ_RATE_INTERVAL_MS);
      const candidates = await p;

      expect(fetchMock).toHaveBeenCalledTimes(2);
      const firstUrl = String(fetchMock.mock.calls[0][0]);
      const secondUrl = String(fetchMock.mock.calls[1][0]);
      expect(firstUrl).not.toContain("dismax=true");
      expect(secondUrl).toContain("dismax=true");
      // The permissive form strips Lucene field prefixes.
      expect(secondUrl).not.toContain("recording%3A");
      expect(secondUrl).not.toContain("artist%3A");

      expect(candidates).toHaveLength(1);
      expect(candidates[0].title).toBe("Love Sponge");
    });

    it("does NOT issue a permissive call when the permissive form equals the strict form", async () => {
      const fetchMock = vi.fn(async () => jsonResponse({ recordings: [] }));
      vi.stubGlobal("fetch", fetchMock);

      // Plain-text query has no Lucene prefixes/quotes to strip, so
      // permissive == strict byte-for-byte. Re-issuing would burn a
      // quota slot for zero new candidates.
      const p = searchRecordings("just plain text", CONTACT);
      await vi.advanceTimersByTimeAsync(0);
      await p;

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("rate limiting", () => {
    it("spaces consecutive requests at MUSICBRAINZ_RATE_INTERVAL_MS", async () => {
      const callTimestamps: number[] = [];
      const fetchMock = vi.fn(async () => {
        callTimestamps.push(Date.now());
        return jsonResponse({
          recordings: [{ id: "x", title: "X" }],
        });
      });
      vi.stubGlobal("fetch", fetchMock);

      const startedAt = Date.now();
      const p1 = searchRecordings('recording:"A" AND artist:"X"', CONTACT);
      const p2 = searchRecordings('recording:"B" AND artist:"Y"', CONTACT);
      const p3 = searchRecordings('recording:"C" AND artist:"Z"', CONTACT);

      await vi.advanceTimersByTimeAsync(0);
      expect(callTimestamps).toEqual([startedAt]);

      await vi.advanceTimersByTimeAsync(MUSICBRAINZ_RATE_INTERVAL_MS);
      expect(callTimestamps).toEqual([
        startedAt,
        startedAt + MUSICBRAINZ_RATE_INTERVAL_MS,
      ]);

      await vi.advanceTimersByTimeAsync(MUSICBRAINZ_RATE_INTERVAL_MS);
      expect(callTimestamps).toEqual([
        startedAt,
        startedAt + MUSICBRAINZ_RATE_INTERVAL_MS,
        startedAt + 2 * MUSICBRAINZ_RATE_INTERVAL_MS,
      ]);

      await Promise.all([p1, p2, p3]);
    });

    it("queue depth observer fires for enqueue, start, and finish", async () => {
      const fetchMock = vi.fn(async () =>
        jsonResponse({ recordings: [{ id: "x", title: "X" }] }),
      );
      vi.stubGlobal("fetch", fetchMock);

      const depths: number[] = [];
      const unsubscribe = getMusicbrainzQueue().observe((d) => depths.push(d));

      // Subscribe fires immediately with the current depth.
      expect(depths[0]).toBe(0);

      const p1 = searchRecordings('recording:"A" AND artist:"X"', CONTACT);
      const p2 = searchRecordings('recording:"B" AND artist:"Y"', CONTACT);

      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(MUSICBRAINZ_RATE_INTERVAL_MS);
      await Promise.all([p1, p2]);

      expect(depths.at(-1)).toBe(0);
      expect(Math.max(...depths)).toBeGreaterThanOrEqual(2);

      unsubscribe();
    });
  });

  describe("503 handling", () => {
    it("retries once on 503, honoring Retry-After", async () => {
      const callTimestamps: number[] = [];
      let callIndex = 0;
      const fetchMock = vi.fn(async () => {
        callTimestamps.push(Date.now());
        callIndex++;
        if (callIndex === 1) return unavailable("2");
        return jsonResponse({
          recordings: [{ id: "rec-1", title: "Recovered" }],
        });
      });
      vi.stubGlobal("fetch", fetchMock);

      const startedAt = Date.now();
      const p = searchRecordings(
        'recording:"A" AND artist:"X"',
        CONTACT,
      );
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(2_500);
      const candidates = await p;

      expect(fetchMock).toHaveBeenCalledTimes(2);
      // Retry honored Retry-After (2s) before re-firing.
      expect(callTimestamps[1] - startedAt).toBeGreaterThanOrEqual(2_000);
      expect(candidates).toHaveLength(1);
      expect(candidates[0].title).toBe("Recovered");
    });

    it("gives up after MAX_503_RETRIES (=1) — a second 503 surfaces as an error", async () => {
      const fetchMock = vi.fn(async () => unavailable("1"));
      vi.stubGlobal("fetch", fetchMock);

      const rej = captureRejection(
        searchRecordings('recording:"A" AND artist:"X"', CONTACT),
      );
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(2_000);

      const error = await rej;
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).toContain("MusicBrainz unavailable");
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  describe("error paths", () => {
    it("surfaces non-2xx responses as Errors with the body", async () => {
      const fetchMock = vi.fn(
        async () =>
          new Response("query syntax error", { status: 400 }),
      );
      vi.stubGlobal("fetch", fetchMock);

      const rej = captureRejection(
        searchRecordings('recording:"A" AND artist:"X"', CONTACT),
      );
      await vi.advanceTimersByTimeAsync(0);

      const error = await rej;
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).toMatch(/MusicBrainz 400/);
    });

    it("treats non-JSON body as a transient error", async () => {
      const fetchMock = vi.fn(
        async () =>
          new Response("<html>maintenance</html>", {
            status: 200,
            headers: { "Content-Type": "text/html" },
          }),
      );
      vi.stubGlobal("fetch", fetchMock);

      const rej = captureRejection(
        searchRecordings('recording:"A" AND artist:"X"', CONTACT),
      );
      await vi.advanceTimersByTimeAsync(0);

      const error = await rej;
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).toContain("non-JSON");
    });

    it("returns [] for an empty query without calling fetch", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      const candidates = await searchRecordings("", CONTACT);
      expect(candidates).toEqual([]);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("recording → candidate mapping", () => {
    it("year prefers recording.first-release-date over earliest release date", async () => {
      const fetchMock = vi.fn(async () =>
        jsonResponse({
          recordings: [
            {
              id: "rec-1",
              title: "Song",
              "artist-credit": [{ name: "Artist" }],
              // first-release-date is canonical; the search endpoint
              // may have returned a later reissue's release.
              "first-release-date": "1995-04-12",
              releases: [
                { id: "rel-2018", title: "Reissue", date: "2018-01-01" },
              ],
            },
          ],
        }),
      );
      vi.stubGlobal("fetch", fetchMock);

      const p = searchRecordings(
        'recording:"Song" AND artist:"Artist"',
        CONTACT,
      );
      await vi.advanceTimersByTimeAsync(0);
      const candidates = await p;

      expect(candidates[0].year).toBe(1995);
      expect(candidates[0].originalYear).toBe(1995);
      expect(candidates[0].releaseId).toBe("rel-2018");
      expect(candidates[0].album).toBe("Reissue");
    });

    it("picks earliest of the returned releases when first-release-date is missing", async () => {
      const fetchMock = vi.fn(async () =>
        jsonResponse({
          recordings: [
            {
              id: "rec-1",
              title: "Song",
              "artist-credit": [{ name: "Artist" }],
              releases: [
                { id: "rel-1995", title: "Album '95", date: "1995-04-12" },
                { id: "rel-2018", title: "Album '18", date: "2018-01-01" },
              ],
            },
          ],
        }),
      );
      vi.stubGlobal("fetch", fetchMock);

      const p = searchRecordings(
        'recording:"Song" AND artist:"Artist"',
        CONTACT,
      );
      await vi.advanceTimersByTimeAsync(0);
      const candidates = await p;

      expect(candidates[0].year).toBe(1995);
      expect(candidates[0].releaseId).toBe("rel-1995");
      expect(candidates[0].album).toBe("Album '95");
      expect(candidates[0].originalYear).toBeUndefined();
    });
  });
});
