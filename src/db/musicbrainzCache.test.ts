import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MB_CACHE_VERSION } from "../constants";
import type { MBCandidate } from "../types";

// In-memory IDB stand-in. The cache module's surface area on `idb` is
// small: `db.get / put / delete / clear / count` plus a `transaction`
// that exposes `tx.store.get / put` and `await tx.done`. We model the
// store as a plain Map keyed by entry.key, which mirrors the real
// `{ keyPath: "key" }` object store created in `database.ts`. The
// transaction helper resolves `done` only after the queued put runs,
// so we can assert read-modify-write atomicity for the CAA negative
// cache.
type StoreRow = Record<string, unknown> & { key: string };

let store: Map<string, StoreRow>;
// Per-store serialization queue. Real IDB serializes `readwrite`
// transactions against the same object store — a second tx on the
// same store can't start until the first one's `done` resolves. The
// fake honors that so the "no lost updates" test exercises the same
// invariant `saveCoverArtNegativeMbids` relies on in production.
let txChain: Promise<void>;

function makeFakeDb() {
  return {
    get: async (_storeName: string, key: string) => store.get(key),
    put: async (_storeName: string, value: StoreRow) => {
      store.set(value.key, value);
      return value.key;
    },
    delete: async (_storeName: string, key: string) => {
      store.delete(key);
    },
    clear: async (_storeName: string) => {
      store.clear();
    },
    count: async (_storeName: string) => store.size,
    transaction: (_storeName: string, mode: "readonly" | "readwrite") => {
      // Each readwrite txn waits for the previous one's `done` before
      // its ops run. We track that with a per-store chain: a new txn
      // captures the current tail, installs its own "done" promise as
      // the new tail, and gates its ops on the captured tail.
      const headReached = txChain;
      let markDone!: () => void;
      const done = new Promise<void>((resolve) => {
        markDone = resolve;
      });
      const isWrite = mode === "readwrite";
      if (isWrite) txChain = done;

      const tx = {
        store: {
          get: async (key: string) => {
            if (isWrite) await headReached;
            return store.get(key);
          },
          put: async (value: StoreRow) => {
            if (isWrite) await headReached;
            store.set(value.key, value);
            return value.key;
          },
          delete: async (key: string) => {
            if (isWrite) await headReached;
            store.delete(key);
          },
          // Minimal cursor over a snapshot of the current rows. Deletes
          // hit the live `store` Map; iteration advances by index over the
          // snapshot, which is sufficient for the version-sweep test (real
          // IDB cursors also tolerate deleting the row under the cursor).
          openCursor: async () => {
            if (isWrite) await headReached;
            const rows = Array.from(store.values());
            let i = 0;
            const makeCursor = (): unknown => {
              if (i >= rows.length) return null;
              const value = rows[i]!;
              return {
                value,
                delete: async () => {
                  store.delete(value.key);
                },
                continue: async () => {
                  i++;
                  return makeCursor();
                },
              };
            };
            return makeCursor();
          },
        },
        get done() {
          return (async () => {
            await headReached;
            // Let queued ops settle before releasing the next txn.
            await Promise.resolve();
            await Promise.resolve();
            markDone();
          })();
        },
      };
      return tx;
    },
  };
}

vi.mock("idb", () => ({
  openDB: vi.fn(async () => makeFakeDb()),
}));

// Imported after the mock so the cache module sees our fake `openDB`.
// We also re-import `getDatabase` from the real module file so the
// internal `dbPromise` cache can be reset between tests by reloading
// the module via `vi.resetModules`.
import {
  buildCacheKey,
  cacheKeyForTrack,
  clearMusicbrainzCache,
  deleteCachedCandidates,
  getCacheSize,
  loadCoverArtNegativeCache,
  pruneStaleCacheEntries,
  readCachedCandidates,
  saveCoverArtNegativeMbids,
  writeCachedCandidates,
  type MBCacheEntry,
} from "./musicbrainzCache";
import { STORE_MB_CACHE } from "./database";

function candidate(overrides: Partial<MBCandidate> = {}): MBCandidate {
  return {
    recordingId: "rec-1",
    title: "Karma Police",
    artist: "Radiohead",
    album: "OK Computer",
    year: 1997,
    score: 0.9,
    ...overrides,
  };
}

beforeEach(() => {
  // Fresh in-memory store per test; the real database connection is
  // mocked at the `idb` boundary so we just clear our backing Map.
  store = new Map();
  txChain = Promise.resolve();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("buildCacheKey", () => {
  it("joins fields with U+001F so adjacent fields cannot collide on rearrangement", () => {
    // Without the unit-separator, ("ab","cd","ef") and ("a","bcd","ef")
    // would both serialize to the same flat string. The delimiter is
    // the whole point of the cache-key contract.
    const left = buildCacheKey({ title: "ab", artist: "cd", album: "ef" });
    const right = buildCacheKey({ title: "a", artist: "bcd", album: "ef" });
    expect(left).not.toBe(right);
  });

  it("uses U+001F exactly as the field delimiter", () => {
    // Hard-coded so a refactor that swaps the delimiter (e.g. to a tab
    // or pipe) breaks loudly here rather than silently invalidating
    // every cached entry on disk.
    const key = buildCacheKey({ title: "a", artist: "b", album: "c" });
    expect(key).toBe("abc");
  });

  it("normalizes inputs so cosmetic variants share one cache key", () => {
    // Case, diacritics, and (Remastered ...) suffixes are all stripped
    // by `normalizeForMatching` before joining — three lookups for the
    // same song must hit the same row.
    const a = buildCacheKey({
      title: "Karma Police",
      artist: "Radiohead",
      album: "OK Computer",
    });
    const b = buildCacheKey({
      title: "Karma Police (Remastered 2017)",
      artist: "RADIOHEAD",
      album: "OK Computer",
    });
    expect(a).toBe(b);
  });

  it("treats undefined fields as empty strings (still delimited)", () => {
    // Tracks without an album tag are common; they must still produce
    // a valid two-field-empty key rather than throwing.
    const key = buildCacheKey({ title: "Song", artist: "Artist" });
    expect(key).toBe("songartist");
  });
});

describe("cacheKeyForTrack", () => {
  it("projects a Track down to the (title, artist, album) shape the cache uses", () => {
    // The helper exists so call sites don't have to know which fields
    // participate in the key — adding/removing one happens here.
    const key = cacheKeyForTrack({
      id: "t1",
      source: { kind: "text" },
      title: "Karma Police",
      artist: "Radiohead",
      album: "OK Computer",
      enrichment: { status: "idle" },
      spotify: { status: "idle" },
    });
    expect(key).toEqual({
      title: "Karma Police",
      artist: "Radiohead",
      album: "OK Computer",
    });
  });
});

describe("read/write round-trip", () => {
  it("returns the same candidates that were written, under the normalized key", () => {
    return (async () => {
      // The cache module owns normalization, so a write with a "noisy"
      // key and a read with a "clean" key must hit the same row.
      const candidates = [candidate(), candidate({ recordingId: "rec-2", score: 0.7 })];
      await writeCachedCandidates(
        { title: "Karma Police (Remastered)", artist: "Radiohead", album: "OK Computer" },
        candidates,
      );
      const out = await readCachedCandidates({
        title: "karma police",
        artist: "RADIOHEAD",
        album: "OK Computer",
      });
      expect(out).toEqual({ kind: "cached", candidates });
    })();
  });

  it("returns a miss when no row exists", async () => {
    // The caller distinguishes "miss" from "cached-empty" off the
    // discriminator — a miss means go fetch; cached-empty means a
    // prior search returned nothing and the caller should honor it.
    const out = await readCachedCandidates({ title: "nope", artist: "nobody" });
    expect(out).toEqual({ kind: "miss" });
  });

  it("stamps the entry with the current MB_CACHE_VERSION", async () => {
    // Version stamping is what lets a constant bump invalidate every
    // entry without a manual clear. Assert the on-disk row carries it.
    await writeCachedCandidates(
      { title: "Song", artist: "Artist" },
      [candidate()],
    );
    const key = buildCacheKey({ title: "Song", artist: "Artist" });
    const row = store.get(key) as MBCacheEntry | undefined;
    expect(row?.version).toBe(MB_CACHE_VERSION);
    expect(typeof row?.cachedAt).toBe("number");
  });

  it("ignores a stale-version entry on read (treats it as a miss)", async () => {
    // Hand-plant a row from an older schema. The reader's version
    // guard must drop it, so the caller re-fetches and overwrites.
    const key = buildCacheKey({ title: "Old", artist: "Old" });
    store.set(key, {
      key,
      candidates: [candidate({ recordingId: "stale" })],
      cachedAt: 1,
      version: MB_CACHE_VERSION - 1,
    } as MBCacheEntry);
    const out = await readCachedCandidates({ title: "Old", artist: "Old" });
    expect(out).toEqual({ kind: "miss" });
  });

  it("ignores a row with no version field (legacy pre-versioning data)", async () => {
    // Pre-versioning rows have `version: undefined`; the guard treats
    // them as stale so we don't accidentally serve obsolete shapes.
    const key = buildCacheKey({ title: "Legacy", artist: "Legacy" });
    store.set(key, {
      key,
      candidates: [candidate()],
      cachedAt: 1,
    } as MBCacheEntry);
    const out = await readCachedCandidates({ title: "Legacy", artist: "Legacy" });
    expect(out).toEqual({ kind: "miss" });
  });
});

describe("deleteCachedCandidates / clearMusicbrainzCache / getCacheSize", () => {
  it("deletes a single row by its normalized key", async () => {
    // Targeted invalidation: a delete with a cosmetic variant of the
    // original key must still find the row, because both flow through
    // the same normalizer.
    await writeCachedCandidates({ title: "Song", artist: "Artist" }, [candidate()]);
    expect(await getCacheSize()).toBe(1);
    await deleteCachedCandidates({ title: "SONG", artist: "Artist" });
    expect(await getCacheSize()).toBe(0);
  });

  it("clears every row in the store", async () => {
    // Used by the "nuke" debug action; must not leave the CAA negative
    // namespace behind either.
    await writeCachedCandidates({ title: "A", artist: "A" }, [candidate()]);
    await writeCachedCandidates({ title: "B", artist: "B" }, [candidate()]);
    await saveCoverArtNegativeMbids(["mbid-1"]);
    expect(await getCacheSize()).toBe(3);
    await clearMusicbrainzCache();
    expect(await getCacheSize()).toBe(0);
  });
});

describe("CAA negative cache namespace isolation", () => {
  it("uses an ASCII-only reserved key that cannot collide with any content key", async () => {
    // Content keys always contain U+001F delimiters (one per field
    // boundary). The negative-cache key uses only ASCII letters, dashes,
    // and double-underscores — so no `buildCacheKey` output can ever
    // overwrite it, even for a track whose normalized fields happen to
    // spell `__cover-art-negative__`.
    await saveCoverArtNegativeMbids(["mbid-a", "mbid-b"]);
    const contentKey = buildCacheKey({
      title: "__cover-art-negative__",
      artist: "",
      album: "",
    });
    expect(contentKey).toContain("");
    expect(contentKey).not.toBe("__cover-art-negative__");
    // Writing a content row with the suggestive title doesn't touch
    // the negative cache.
    await writeCachedCandidates(
      { title: "__cover-art-negative__", artist: "", album: "" },
      [candidate()],
    );
    expect(await loadCoverArtNegativeCache()).toEqual(["mbid-a", "mbid-b"]);
  });

  it("returns an empty array when no negative entry has been written", async () => {
    // First-run shape: callers expect `[]`, not `null`/`undefined`,
    // so they can spread it into a Set without a guard.
    expect(await loadCoverArtNegativeCache()).toEqual([]);
  });
});

describe("saveCoverArtNegativeMbids", () => {
  it("is a no-op for an empty input array", async () => {
    // Avoid writing an empty negative row that would then need to be
    // merged into on every subsequent call. The early-return is the
    // contract the call site relies on.
    await saveCoverArtNegativeMbids([]);
    expect(store.size).toBe(0);
  });

  it("merges into the existing entry instead of overwriting it", async () => {
    // Sequential writes accumulate. A second call with one new mbid
    // must keep the earlier ones around.
    await saveCoverArtNegativeMbids(["a", "b"]);
    await saveCoverArtNegativeMbids(["c"]);
    const out = await loadCoverArtNegativeCache();
    expect(out.sort()).toEqual(["a", "b", "c"]);
  });

  it("de-duplicates mbids across calls (Set semantics)", async () => {
    // The merged set must not re-add an mbid the previous call already
    // saved — otherwise repeated CAA misses would balloon the list.
    await saveCoverArtNegativeMbids(["a", "b"]);
    await saveCoverArtNegativeMbids(["b", "c", "c"]);
    const out = await loadCoverArtNegativeCache();
    expect(out.sort()).toEqual(["a", "b", "c"]);
  });

  it("performs the read-modify-write inside a single transaction (no lost updates)", async () => {
    // Two concurrent callers must both land their additions. We launch
    // both in parallel; under a correct read-modify-write-in-one-txn
    // implementation the final set is the union of both inputs. (A
    // naive `get(); set(merge(...))` outside a transaction would lose
    // one side's contribution if both reads happened before either
    // write.)
    await Promise.all([
      saveCoverArtNegativeMbids(["a", "b"]),
      saveCoverArtNegativeMbids(["c", "d"]),
    ]);
    const out = await loadCoverArtNegativeCache();
    expect(out.sort()).toEqual(["a", "b", "c", "d"]);
  });

  it("writes the entry into the same object store as content rows", async () => {
    // Sanity check on the store name constant — if a refactor split
    // negatives into a different store, the namespace-isolation
    // argument above no longer holds and this assertion catches it.
    await saveCoverArtNegativeMbids(["mbid-1"]);
    expect(STORE_MB_CACHE).toBe("mb_cache");
    expect(store.size).toBe(1);
  });
});

describe("writeCachedCandidates with empty input", () => {
  it("does write through empty arrays (filtering is the caller's job)", async () => {
    // Per enrichmentService.ts, the call site guards `primaryScored.length > 0`
    // before invoking writeCachedCandidates. The cache module itself is
    // a thin persister and stores whatever it's handed — documenting
    // that contract here so a future "helpful" guard inside the cache
    // doesn't silently change behavior for callers that DO want to
    // persist an empty result (true no-query negative-cache slots).
    await writeCachedCandidates({ title: "Q", artist: "Q" }, []);
    const out = await readCachedCandidates({ title: "Q", artist: "Q" });
    expect(out).toEqual({ kind: "cached", candidates: [] });
  });
});

describe("pruneStaleCacheEntries", () => {
  function contentRow(key: string, version: number | undefined): StoreRow {
    const row: StoreRow = { key, candidates: [candidate()], cachedAt: 1 };
    if (version !== undefined) row.version = version;
    return row;
  }

  it("deletes content rows at a stale (or missing) version and keeps current-version rows", async () => {
    store.set("stale", contentRow("stale", MB_CACHE_VERSION - 1));
    store.set("current", contentRow("current", MB_CACHE_VERSION));
    store.set("unversioned", contentRow("unversioned", undefined));

    const removed = await pruneStaleCacheEntries();

    expect(removed).toBe(2);
    expect(store.has("stale")).toBe(false);
    expect(store.has("unversioned")).toBe(false);
    expect(store.has("current")).toBe(true);
  });

  it("never deletes the CAA negative-cache row even though it carries no version field", async () => {
    // Seed the negative-cache row through its real writer so the schema
    // matches production exactly, then add a stale content row alongside.
    await saveCoverArtNegativeMbids(["mbid-1", "mbid-2"]);
    store.set("stale", contentRow("stale", MB_CACHE_VERSION - 1));

    const removed = await pruneStaleCacheEntries();

    expect(removed).toBe(1);
    expect(store.has("stale")).toBe(false);
    // The negative cache survived the version sweep intact.
    expect(await loadCoverArtNegativeCache()).toEqual(["mbid-1", "mbid-2"]);
  });

  it("returns 0 and deletes nothing when every content row is current", async () => {
    store.set("a", contentRow("a", MB_CACHE_VERSION));
    store.set("b", contentRow("b", MB_CACHE_VERSION));
    const removed = await pruneStaleCacheEntries();
    expect(removed).toBe(0);
    expect(store.size).toBe(2);
  });
});

describe("saveCoverArtNegativeMbids — FIFO eviction at the cap", () => {
  // Mirrors MAX_NEGATIVE_CACHE_SIZE in musicbrainzCache.ts. If that
  // constant changes, this expectation should be updated in lock-step.
  const CAP = 10_000;

  it("evicts the oldest MBIDs (FIFO) once the merged list exceeds the cap", async () => {
    const seeded = Array.from({ length: CAP }, (_, i) => `mbid-${i}`);
    await saveCoverArtNegativeMbids(seeded);
    expect((await loadCoverArtNegativeCache()).length).toBe(CAP);

    // Three fresh misses push the list to CAP+3 → the three oldest are
    // trimmed from the head, newest kept at the tail.
    await saveCoverArtNegativeMbids(["new-a", "new-b", "new-c"]);

    const result = await loadCoverArtNegativeCache();
    expect(result.length).toBe(CAP);
    expect(result).not.toContain("mbid-0");
    expect(result).not.toContain("mbid-1");
    expect(result).not.toContain("mbid-2");
    expect(result).toContain("mbid-3"); // oldest survivor
    expect(result.slice(-3)).toEqual(["new-a", "new-b", "new-c"]);
  });

  it("does not evict when the merged list is exactly at the cap", async () => {
    const seeded = Array.from({ length: CAP - 1 }, (_, i) => `mbid-${i}`);
    await saveCoverArtNegativeMbids(seeded);
    await saveCoverArtNegativeMbids(["last"]);
    const result = await loadCoverArtNegativeCache();
    expect(result.length).toBe(CAP);
    expect(result).toContain("mbid-0");
    expect(result.at(-1)).toBe("last");
  });
});
