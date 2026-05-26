import { openDB, type IDBPDatabase } from "idb";

const DB_NAME = "curator";
const DB_VERSION = 1;

export const STORE_PLAYLISTS = "playlists";
export const STORE_TRACKS = "tracks";
export const STORE_MB_CACHE = "mb_cache";

let dbPromise: Promise<IDBPDatabase> | null = null;

export function getDatabase(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE_PLAYLISTS)) {
          db.createObjectStore(STORE_PLAYLISTS, { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains(STORE_TRACKS)) {
          db.createObjectStore(STORE_TRACKS, { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains(STORE_MB_CACHE)) {
          db.createObjectStore(STORE_MB_CACHE, { keyPath: "key" });
        }
      },
    });
  }
  return dbPromise;
}
