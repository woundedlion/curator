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

export function buildCacheKey({ title, artist, album }: MBCacheKey): string {
  return `${title} ${artist} ${album}`;
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
