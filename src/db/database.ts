import { openDB, type IDBPDatabase } from "idb";

const DB_NAME = "curator";

// Schema version. Bump this whenever the structure of an object store
// changes, or a new store is added. Every bump MUST have a corresponding
// case in `upgrade()` below — `idb` walks from oldVersion+1 up to the
// target version, applying each case in order. Adding a new store is
// idempotent because of the `contains` guard, but renames, index
// additions, and field migrations must be explicit.
const DB_VERSION = 1;

export const STORE_PLAYLISTS = "playlists";
export const STORE_TRACKS = "tracks";
export const STORE_MB_CACHE = "mb_cache";

let dbPromise: Promise<IDBPDatabase> | null = null;

export function getDatabase(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db, oldVersion, _newVersion, _tx) {
        // Each `if (oldVersion < N)` block runs when we are migrating FROM
        // a database that pre-dates version N. Cases must be ordered
        // ascending so a brand-new install (oldVersion=0) walks the full
        // chain. When you bump DB_VERSION, add a new block here — do NOT
        // edit prior blocks (they describe the path users with older
        // databases will take to reach the new version).
        if (oldVersion < 1) {
          if (!db.objectStoreNames.contains(STORE_PLAYLISTS)) {
            db.createObjectStore(STORE_PLAYLISTS, { keyPath: "id" });
          }
          if (!db.objectStoreNames.contains(STORE_TRACKS)) {
            db.createObjectStore(STORE_TRACKS, { keyPath: "id" });
          }
          if (!db.objectStoreNames.contains(STORE_MB_CACHE)) {
            db.createObjectStore(STORE_MB_CACHE, { keyPath: "key" });
          }
        }
      },
      blocked() {
        console.warn(
          "Curator: another tab holds an older IndexedDB version open. Close it and reload.",
        );
      },
      terminated() {
        // Connection dropped unexpectedly (storage cleared, profile
        // wiped, etc.) — drop the cached promise so the next call
        // re-opens the database from scratch.
        dbPromise = null;
      },
    });
  }
  return dbPromise;
}
