import { MB_CACHE_VERSION } from "../constants";
import { getDatabase, STORE_MB_CACHE } from "./database";
import type { MBCandidate } from "../types";

export type MBCacheKey = {
  title: string;
  artist: string;
  album: string;
};

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

type CoverArtNegativeEntry = {
  key: typeof COVER_ART_NEGATIVE_KEY;
  mbids: string[];
};

export function buildCacheKey({ title, artist, album }: MBCacheKey): string {
  return `${title}${KEY_DELIMITER}${artist}${KEY_DELIMITER}${album}`;
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
  const merged = new Set(existing?.mbids ?? []);
  for (const mbid of newMbids) merged.add(mbid);
  const entry: CoverArtNegativeEntry = {
    key: COVER_ART_NEGATIVE_KEY,
    mbids: Array.from(merged),
  };
  await tx.store.put(entry);
  await tx.done;
}
