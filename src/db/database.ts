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

export class IndexedDBUnavailableError extends Error {
  constructor() {
    super(
      "IndexedDB is not available in this browser context (private mode, " +
        "third-party-cookies blocked, or storage gated). Persistence is disabled.",
    );
    this.name = "IndexedDBUnavailableError";
  }
}

export function getDatabase(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    // Some browsers expose `indexedDB` as `undefined` rather than
    // throwing on access — older Safari Private Browsing, embedded
    // contexts with storage gated, and SSR / test harnesses without
    // a shim. Wrap `openDB` so that synchronous failures from inside
    // idb's call chain surface as a typed IndexedDBUnavailableError
    // instead of a confusing `ReferenceError: indexedDB is not
    // defined`. We DON'T pre-check `typeof indexedDB` here — that
    // bypasses test setups that mock `openDB` directly without
    // installing a global IDB shim.
    let opened: Promise<IDBPDatabase>;
    try {
      opened = openDB(DB_NAME, DB_VERSION, {
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
        blocking() {
          // A newer-version connection (another tab on a freshly deployed
          // build) is waiting to upgrade and is blocked by THIS open
          // connection. If we hold the connection open the other tab's
          // `upgradeneeded` never fires and its open hangs indefinitely.
          // Close our connection so the upgrade can proceed, and null the
          // cache so the next getDatabase() call re-opens at the new
          // version rather than handing back the now-closed handle.
          //
          // idb's `blocking` callback doesn't hand us the db, so close via
          // the cached promise — by the time this fires the open has
          // resolved, so the handle is available. Reading `opened` (the
          // pre-`.catch` promise) rather than `dbPromise` avoids racing
          // the null-out below.
          console.warn(
            "Curator: closing IndexedDB connection so another tab can upgrade.",
          );
          void opened.then((db) => db.close()).catch(() => undefined);
          dbPromise = null;
        },
        terminated() {
          // Connection dropped unexpectedly (storage cleared, profile
          // wiped, etc.) — drop the cached promise so the next call
          // re-opens the database from scratch.
          dbPromise = null;
        },
      });
    } catch (cause) {
      // `openDB` (or the underlying `indexedDB.open`) threw
      // synchronously — usually because `indexedDB` itself is
      // undefined. Surface a typed error and don't cache it so a
      // later call in a context where IDB became available retries.
      const failed = Promise.reject(
        Object.assign(new IndexedDBUnavailableError(), { cause }),
      );
      failed.catch(() => undefined);
      return failed;
    }
    dbPromise = opened.catch((cause) => {
      // Async failure inside openDB (e.g. user rejected storage
      // request). Drop the cached promise so retries can succeed.
      dbPromise = null;
      throw Object.assign(new IndexedDBUnavailableError(), { cause });
    });
  }
  return dbPromise;
}
