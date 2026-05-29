import { MB_CACHE_VERSION } from "../constants";
import { normalizeForMatching } from "../metadata/normalizers";
import { getDatabase, STORE_MB_CACHE } from "./database";
import type { MBCandidate, Track } from "../types";

// Raw (un-normalized) inputs. The cache module owns the normalization
// contract — every read/write goes through `buildCacheKey`, which calls
// `normalizeForMatching` internally. This keeps the three call sites
// (enrich, runner, picker) from drifting on what "same key" means.
export type MBCacheKey = {
  title?: string;
  artist?: string;
  album?: string;
};

export function cacheKeyForTrack(track: Track): MBCacheKey {
  return { title: track.title, artist: track.artist, album: track.album };
}

export type MBCacheEntry = {
  key: string;
  candidates: MBCandidate[];
  cachedAt: number;
  version?: number;
};

// Unit-separator delimiter (U+001F) — a control character that cannot
// appear in normalized text. Joining with this avoids the collision class
// where `("A B", "C", "D")` and `("A", "B C", "D")` would both map to
// `"A B C D"` if delimited by a space.
const KEY_DELIMITER = "";

// Reserved key namespace for entries that aren't normal MB cache rows
// (currently the CAA negative cache). The prefix uses ASCII characters
// only — the unit-separator above would never appear here, so namespace
// values can never collide with content keys.
const COVER_ART_NEGATIVE_KEY = "__cover-art-negative__";

// Hard cap on the persisted negative-cache list. Every entry is a 36-char
// MBID, so the cap bounds the row at ~360 KB — well inside IDB headroom
// even on resource-constrained tabs. The cache only stores releases CAA
// has confirmed have no front art, so a true entry count above this cap
// would require importing 100k+ distinct uncovered releases in a single
// browser profile — unrealistic in practice, but capped to bound worst
// case. Eviction is FIFO (insertion order — preserved by JS Set iteration
// and by the on-disk array). The oldest MBIDs are the most likely to
// have been re-covered upstream since their 404, so FIFO also doubles
// as a coarse "rotate stale negatives out" policy without needing per-
// entry timestamps.
const MAX_NEGATIVE_CACHE_SIZE = 10_000;

type CoverArtNegativeEntry = {
  key: typeof COVER_ART_NEGATIVE_KEY;
  mbids: string[];
};

export function buildCacheKey({ title, artist, album }: MBCacheKey): string {
  return `${normalizeForMatching(title)}${KEY_DELIMITER}${normalizeForMatching(artist)}${KEY_DELIMITER}${normalizeForMatching(album)}`;
}

function isCurrentVersion(entry: MBCacheEntry | undefined): boolean {
  return entry?.version === MB_CACHE_VERSION;
}

export async function readCachedCandidates(
  key: MBCacheKey,
): Promise<MBCandidate[] | null> {
  const db = await getDatabase();
  const entry = (await db.get(STORE_MB_CACHE, buildCacheKey(key))) as
    | MBCacheEntry
    | undefined;
  if (!isCurrentVersion(entry)) return null;
  return entry?.candidates ?? null;
}

export async function writeCachedCandidates(
  key: MBCacheKey,
  candidates: MBCandidate[],
): Promise<void> {
  const db = await getDatabase();
  const entry: MBCacheEntry = {
    key: buildCacheKey(key),
    candidates,
    cachedAt: Date.now(),
    version: MB_CACHE_VERSION,
  };
  await db.put(STORE_MB_CACHE, entry);
}

export async function clearMusicbrainzCache(): Promise<void> {
  const db = await getDatabase();
  await db.clear(STORE_MB_CACHE);
}

export async function deleteCachedCandidates(key: MBCacheKey): Promise<void> {
  const db = await getDatabase();
  await db.delete(STORE_MB_CACHE, buildCacheKey(key));
}

export async function getCacheSize(): Promise<number> {
  const db = await getDatabase();
  return db.count(STORE_MB_CACHE);
}

// One-shot sweep that eagerly deletes entries with a stale `version`
// field. Without it, a MB_CACHE_VERSION bump leaves dead rows
// permanently resident — `readCachedCandidates` skips them (so they
// don't return wrong data), but they still consume IDB quota and slow
// down `getCacheSize`. Called from `useAppBootstrap` so the cleanup
// runs once per tab session, not on every read.
//
// CAA negative-cache entries (`__cover-art-negative__`) carry no
// `version` field by design — they're a separate schema. The sweep
// skips them explicitly so a version bump doesn't wipe a known-good
// negative cache that's still valid against CAA's actual 404 set.
export async function pruneStaleCacheEntries(): Promise<number> {
  const db = await getDatabase();
  const tx = db.transaction(STORE_MB_CACHE, "readwrite");
  let cursor = await tx.store.openCursor();
  let removed = 0;
  while (cursor) {
    const entry = cursor.value as MBCacheEntry | CoverArtNegativeEntry;
    const isContent =
      typeof entry.key === "string" && entry.key !== COVER_ART_NEGATIVE_KEY;
    if (isContent && (entry as MBCacheEntry).version !== MB_CACHE_VERSION) {
      await cursor.delete();
      removed++;
    }
    cursor = await cursor.continue();
  }
  await tx.done;
  return removed;
}

export async function loadCoverArtNegativeCache(): Promise<string[]> {
  const db = await getDatabase();
  const entry = (await db.get(STORE_MB_CACHE, COVER_ART_NEGATIVE_KEY)) as
    | CoverArtNegativeEntry
    | undefined;
  return entry?.mbids ?? [];
}

export async function saveCoverArtNegativeMbids(
  newMbids: string[],
): Promise<void> {
  if (newMbids.length === 0) return;
  const db = await getDatabase();
  const tx = db.transaction(STORE_MB_CACHE, "readwrite");
  const existing = (await tx.store.get(COVER_ART_NEGATIVE_KEY)) as
    | CoverArtNegativeEntry
    | undefined;
  // Set preserves insertion order, so building it from
  // existing-then-new gives us oldest → newest. When the merged size
  // exceeds the cap, slice off the head (oldest) so survivors are the
  // most recently observed misses.
  const merged = new Set(existing?.mbids ?? []);
  for (const mbid of newMbids) merged.add(mbid);
  const mbids =
    merged.size <= MAX_NEGATIVE_CACHE_SIZE
      ? Array.from(merged)
      : Array.from(merged).slice(merged.size - MAX_NEGATIVE_CACHE_SIZE);
  const entry: CoverArtNegativeEntry = {
    key: COVER_ART_NEGATIVE_KEY,
    mbids,
  };
  await tx.store.put(entry);
  await tx.done;
}
