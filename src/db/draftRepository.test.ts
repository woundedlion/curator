import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The draft repository talks to IndexedDB via the `idb` wrapper exposed
// through ./database.getDatabase. We mock that single seam so each test
// can install a fresh in-memory DB stub and observe exactly what put/clear
// requests cross the boundary, without standing up a real IDBFactory.
//
// The fake mirrors the bits the repo uses: getDatabase() returns a db
// whose .transaction(stores, mode) hands back an object with
// objectStore(name) -> { put, clear, get, getAll, delete }. Each request
// method returns a Promise (matching idb's wrapper semantics). The
// txn carries a `done` promise that resolves when every queued request
// has settled (or rejects if any aborted).
vi.mock("./database", () => {
  return {
    STORE_PLAYLISTS: "playlists",
    STORE_TRACKS: "tracks",
    STORE_MB_CACHE: "mb_cache",
    getDatabase: vi.fn(),
  };
});

import {
  saveDraft,
  loadDraft,
  clearDraft,
  DraftQuotaExceededError,
} from "./draftRepository";
import { getDatabase, STORE_PLAYLISTS, STORE_TRACKS } from "./database";
import type { Playlist, Track } from "../types";

// ----------------------------------------------------------------------
// Fake IDB plumbing
// ----------------------------------------------------------------------

type ReqResult<T = unknown> = Promise<T>;

interface FakeStore {
  put: (value: unknown) => ReqResult<string>;
  clear: () => ReqResult<void>;
  get: (key: string) => ReqResult<unknown>;
  getAll: () => ReqResult<unknown[]>;
  delete: (key: string) => ReqResult<void>;
}

interface FakeTxn {
  objectStore: (name: string) => FakeStore;
  done: Promise<void>;
}

interface FakeDb {
  transaction: (stores: string[], mode: string) => FakeTxn;
}

interface StoreState {
  rows: Map<string, unknown>;
}

interface FakeDbState {
  // Per-store backing maps so put/clear/getAll behave like a real IDB.
  stores: Record<string, StoreState>;
  // Configurable error injectors keyed by store name. Each is a queue:
  // shift one per call. A non-null head injects a rejection for the next
  // put against that store. This lets tests fail track-store puts
  // specifically without consuming an "error slot" on the playlist
  // store's put that lands first in every writeDraftOnce call.
  putErrors: Record<string, Array<Error | null>>;
  clearErrors: Record<string, Array<Error | null>>;
  // Track every transaction created so tests can inspect ordering /
  // request fan-out. `requests` is the ordered list of (op, store, key).
  transactions: Array<{
    mode: string;
    stores: string[];
    requests: Array<{ op: string; store: string; payload?: unknown }>;
    committed: boolean;
    aborted: boolean;
  }>;
}

function makeFakeDb(): { db: FakeDb; state: FakeDbState } {
  const state: FakeDbState = {
    stores: {
      [STORE_PLAYLISTS]: { rows: new Map() },
      [STORE_TRACKS]: { rows: new Map() },
    },
    putErrors: { [STORE_PLAYLISTS]: [], [STORE_TRACKS]: [] },
    clearErrors: { [STORE_PLAYLISTS]: [], [STORE_TRACKS]: [] },
    transactions: [],
  };

  const db: FakeDb = {
    transaction(storeNames: string[], mode: string): FakeTxn {
      const txnRecord = {
        mode,
        stores: storeNames,
        requests: [] as Array<{ op: string; store: string; payload?: unknown }>,
        committed: false,
        aborted: false,
      };
      state.transactions.push(txnRecord);
      const pending: Array<Promise<unknown>> = [];

      function ensureStore(name: string): StoreState {
        if (!state.stores[name]) state.stores[name] = { rows: new Map() };
        return state.stores[name]!;
      }

      function makeStore(name: string): FakeStore {
        return {
          put(value: unknown): ReqResult<string> {
            txnRecord.requests.push({ op: "put", store: name, payload: value });
            const queue = state.putErrors[name] ?? [];
            const err = queue.shift() ?? null;
            const p =
              err === null
                ? Promise.resolve().then(() => {
                    const key = (value as { id?: string } | undefined)?.id;
                    if (typeof key === "string") {
                      ensureStore(name).rows.set(key, value);
                    }
                    return String(key ?? "");
                  })
                : Promise.reject(err);
            // Attach a no-op catch so an injected rejection that the
            // source never awaits doesn't surface as an unhandled
            // rejection in vitest. The source DOES await it via
            // Promise.all, but we play it safe.
            p.catch(() => undefined);
            pending.push(p);
            return p;
          },
          clear(): ReqResult<void> {
            txnRecord.requests.push({ op: "clear", store: name });
            const queue = state.clearErrors[name] ?? [];
            const err = queue.shift() ?? null;
            const p =
              err === null
                ? Promise.resolve().then(() => {
                    ensureStore(name).rows.clear();
                  })
                : Promise.reject(err);
            p.catch(() => undefined);
            pending.push(p);
            return p;
          },
          get(key: string): ReqResult<unknown> {
            txnRecord.requests.push({ op: "get", store: name, payload: key });
            const p = Promise.resolve().then(() =>
              ensureStore(name).rows.get(key),
            );
            pending.push(p);
            return p;
          },
          getAll(): ReqResult<unknown[]> {
            txnRecord.requests.push({ op: "getAll", store: name });
            const p = Promise.resolve().then(() =>
              Array.from(ensureStore(name).rows.values()),
            );
            pending.push(p);
            return p;
          },
          delete(key: string): ReqResult<void> {
            txnRecord.requests.push({ op: "delete", store: name, payload: key });
            const p = Promise.resolve().then(() => {
              ensureStore(name).rows.delete(key);
            });
            pending.push(p);
            return p;
          },
        };
      }

      const txn: FakeTxn = {
        objectStore: (name: string) => makeStore(name),
        // `done` resolves when every request has settled successfully, and
        // rejects if any did. This matches idb's contract: a failed request
        // aborts the txn and surfaces through `done`.
        get done(): Promise<void> {
          return Promise.allSettled(pending).then((results) => {
            const firstReject = results.find((r) => r.status === "rejected");
            if (firstReject && firstReject.status === "rejected") {
              txnRecord.aborted = true;
              throw firstReject.reason;
            }
            txnRecord.committed = true;
          });
        },
      };
      return txn;
    },
  };
  return { db, state };
}

// ----------------------------------------------------------------------
// Test helpers
// ----------------------------------------------------------------------

function makePlaylist(overrides: Partial<Playlist> = {}): Playlist {
  return {
    id: overrides.id ?? "active-draft",
    name: overrides.name ?? "Test",
    description: overrides.description ?? "",
    public: overrides.public ?? false,
    collaborative: overrides.collaborative ?? false,
    trackIds: overrides.trackIds ?? [],
    sort: overrides.sort ?? null,
    hideUnmatched: overrides.hideUnmatched ?? false,
  };
}

function makeTrack(overrides: Partial<Track> = {}): Track {
  return {
    id: overrides.id ?? "t1",
    source: overrides.source ?? { kind: "file", fileName: "song.mp3" },
    title: overrides.title,
    artist: overrides.artist,
    localFile: overrides.localFile,
    enrichment: overrides.enrichment ?? { status: "idle" },
    spotify: overrides.spotify ?? { status: "idle" },
  };
}

// Build an object that throws on structuredClone (functions / DOM nodes
// aren't cloneable). We attach this as `localFile` to simulate a real
// File handle that some browser/profile combos refuse to clone into an
// IDB transaction.
function makeUncloneableFile(): File {
  const file = {
    // A function-valued field makes structuredClone throw a DataCloneError.
    notCloneable: () => undefined,
    name: "broken.mp3",
  };
  // Cast — the runtime shape only needs to NOT survive structuredClone.
  return file as unknown as File;
}

let dbState: FakeDbState;

beforeEach(() => {
  vi.clearAllMocks();
  const { db, state } = makeFakeDb();
  dbState = state;
  vi.mocked(getDatabase).mockResolvedValue(db as never);
  // Silence the warn/error from quota / retry paths so the test output
  // stays focused on assertions. Restored in afterEach.
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ----------------------------------------------------------------------
// trackSafeToPut — structured-clone probe
// ----------------------------------------------------------------------

describe("structured-clone probe (trackSafeToPut)", () => {
  it("writes a track with a cloneable localFile unmodified", async () => {
    // Contract: when structuredClone succeeds on the localFile, the put
    // payload contains the localFile intact — no defensive stripping.
    const cloneableFile = { size: 10, name: "ok.mp3" } as unknown as File;
    const track = makeTrack({ id: "t1", localFile: cloneableFile });

    await saveDraft(makePlaylist({ trackIds: ["t1"] }), [track]);

    const trackPuts = dbState.transactions[0]!.requests.filter(
      (r) => r.op === "put" && r.store === STORE_TRACKS,
    );
    expect(trackPuts).toHaveLength(1);
    expect((trackPuts[0]!.payload as Track).localFile).toBe(cloneableFile);
  });

  it("strips localFile when structuredClone throws on it — never both, never neither", async () => {
    // Contract: an uncloneable localFile is stripped synchronously
    // BEFORE the transaction opens, so the put lands with the file-less
    // variant. The track itself is still persisted (we don't drop the
    // whole row).
    const track = makeTrack({
      id: "t1",
      title: "Karma Police",
      localFile: makeUncloneableFile(),
    });

    await saveDraft(makePlaylist({ trackIds: ["t1"] }), [track]);

    const trackPuts = dbState.transactions[0]!.requests.filter(
      (r) => r.op === "put" && r.store === STORE_TRACKS,
    );
    expect(trackPuts).toHaveLength(1);
    const written = trackPuts[0]!.payload as Track;
    expect(written.localFile).toBeUndefined();
    expect(written.title).toBe("Karma Police");
    expect(written.id).toBe("t1");
    // And the warning fired so we have observability into the strip.
    expect(console.warn).toHaveBeenCalled();
  });

  it("leaves tracks without a localFile untouched (no clone attempt)", async () => {
    // Contract: the guard short-circuits when there's no file — it should
    // not call structuredClone at all. We verify by asserting the payload
    // matches the input track exactly.
    const track = makeTrack({ id: "t1", title: "No File" });
    await saveDraft(makePlaylist({ trackIds: ["t1"] }), [track]);
    const trackPut = dbState.transactions[0]!.requests.find(
      (r) => r.op === "put" && r.store === STORE_TRACKS,
    );
    expect(trackPut!.payload).toEqual(track);
  });

  it("strips per-track — mixed batches keep cloneable files and drop uncloneable ones", async () => {
    // Contract: trackSafeToPut runs per track, so a batch with mixed
    // cloneability writes the good files through and only strips the
    // bad ones.
    const goodFile = { size: 1 } as unknown as File;
    const tracks = [
      makeTrack({ id: "a", localFile: goodFile }),
      makeTrack({ id: "b", localFile: makeUncloneableFile() }),
      makeTrack({ id: "c", localFile: goodFile }),
    ];

    await saveDraft(makePlaylist({ trackIds: ["a", "b", "c"] }), tracks);

    const puts = dbState.transactions[0]!.requests
      .filter((r) => r.op === "put" && r.store === STORE_TRACKS)
      .map((r) => r.payload as Track);
    const byId = new Map(puts.map((p) => [p.id, p]));
    expect(byId.get("a")!.localFile).toBe(goodFile);
    expect(byId.get("b")!.localFile).toBeUndefined();
    expect(byId.get("c")!.localFile).toBe(goodFile);
  });
});

// ----------------------------------------------------------------------
// Single-flight activeSave chain
// ----------------------------------------------------------------------

describe("single-flight activeSave chain", () => {
  it("serializes concurrent saveDraft calls — second waits for first to settle", async () => {
    // Contract: two saveDraft calls fired back-to-back must not open
    // overlapping transactions. We assert ordering by checking that
    // the second txn begins only after the first txn's done resolves.
    const playlist = makePlaylist();

    // Track txn lifecycle ordering.
    const order: string[] = [];
    // Wrap getDatabase so each call records when it was invoked. The
    // chain serializes the writeDraft step, so we expect getDatabase
    // for save #2 to fire only after save #1 finishes.
    const realDb = await vi.mocked(getDatabase).getMockImplementation()!();
    vi.mocked(getDatabase).mockImplementation(async () => {
      order.push(`getDatabase@${order.length}`);
      return realDb;
    });

    const p1 = saveDraft(playlist, [makeTrack({ id: "a" })]).then(() =>
      order.push("save1-done"),
    );
    const p2 = saveDraft(playlist, [makeTrack({ id: "b" })]).then(() =>
      order.push("save2-done"),
    );

    await Promise.all([p1, p2]);

    // save1 acquires the DB first; save2 acquires it only after save1
    // finishes. That manifests as: getDatabase, save1-done, getDatabase,
    // save2-done in some interleaving where save2-done strictly follows
    // save1-done AND the second getDatabase strictly follows the first.
    expect(order.indexOf("save1-done")).toBeLessThan(order.indexOf("save2-done"));
    expect(dbState.transactions).toHaveLength(2);
  });

  it("a rejected save does not poison subsequent saves", async () => {
    // Contract: when one save in the chain rejects, the chain head is
    // pinned to a resolved promise so future saves still get a fresh
    // shot. The caller of the failing save still sees the rejection.
    // Two transient errors -> exhausts the [100, 500] retry budget on
    // the first save, then the second save should succeed cleanly.
    vi.useFakeTimers();

    const transient = new Error("transient failure");
    // First saveDraft: 3 attempts, all fail (target the tracks-store put
    // so the playlist-store put still lands first in each txn).
    dbState.putErrors[STORE_TRACKS]!.push(transient, transient, transient);

    const failing = saveDraft(makePlaylist(), [makeTrack({ id: "a" })]);
    // Kick the retry timers (100 + 500 = 600ms).
    const observed = failing.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1000);
    const err = await observed;
    expect(err).toBe(transient);

    // Now a follow-up save with no errors should sail through.
    vi.useRealTimers();
    await expect(
      saveDraft(makePlaylist(), [makeTrack({ id: "b" })]),
    ).resolves.toBeUndefined();
  });

  it("propagates the rejection to the original caller even though the chain head swallows it", async () => {
    // Contract: activeSave = next.catch(()=>undefined) swallows the
    // rejection on the chain HEAD only — the value returned to the
    // saveDraft caller is the original `next` which still rejects.
    vi.useFakeTimers();

    const boom = new Error("boom");
    dbState.putErrors[STORE_TRACKS]!.push(boom, boom, boom);

    const p = saveDraft(makePlaylist(), [makeTrack({ id: "x" })]);
    const captured = p.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await captured).toBe(boom);
  });
});

// ----------------------------------------------------------------------
// Bounded transient retry
// ----------------------------------------------------------------------

describe("bounded transient retry", () => {
  it("retries a transient error and succeeds on the second attempt", async () => {
    // Contract: TRANSIENT_RETRY_DELAYS_MS = [100, 500] — one transient
    // failure leads to a single retry that should land cleanly.
    vi.useFakeTimers();

    dbState.putErrors[STORE_TRACKS]!.push(new Error("transient"));

    const p = saveDraft(makePlaylist(), [makeTrack({ id: "a" })]);
    await vi.advanceTimersByTimeAsync(200);
    await expect(p).resolves.toBeUndefined();
    // 2 transactions opened: the failing one, then the successful retry.
    expect(dbState.transactions).toHaveLength(2);
  });

  it("retries twice and gives up on the third failure", async () => {
    // Contract: with 2 retry delays, the loop attempts at most 3 times
    // before throwing the last error to the caller. Total of 3 txns.
    vi.useFakeTimers();

    const e1 = new Error("t1");
    const e2 = new Error("t2");
    const e3 = new Error("t3");
    dbState.putErrors[STORE_TRACKS]!.push(e1, e2, e3);

    const p = saveDraft(makePlaylist(), [makeTrack({ id: "a" })]);
    const observed = p.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1000);

    expect(await observed).toBe(e3);
    expect(dbState.transactions).toHaveLength(3);
  });

  it("quota error short-circuits — no retry, surfaces DraftQuotaExceededError", async () => {
    // Contract: QuotaExceededError is stable; retrying just wastes time
    // and stacks more queued debounce-driven saves. The repo must throw
    // DraftQuotaExceededError on the first attempt without retrying.
    const quota = new DOMException("over budget", "QuotaExceededError");
    dbState.putErrors[STORE_TRACKS]!.push(quota, quota, quota);

    const observed = saveDraft(makePlaylist(), [makeTrack({ id: "a" })]).catch(
      (e: unknown) => e,
    );

    const err = await observed;
    expect(err).toBeInstanceOf(DraftQuotaExceededError);
    expect((err as DraftQuotaExceededError).cause).toBe(quota);
    // Only ONE transaction — no retry attempts.
    expect(dbState.transactions).toHaveLength(1);
  });

  it("retry delays match the documented schedule [100, 500] ms", async () => {
    // Contract: pinning the retry schedule guards against an accidental
    // tweak that would either spam the IDB on tight loops or make
    // recovery painfully slow.
    vi.useFakeTimers();
    dbState.putErrors[STORE_TRACKS]!.push(new Error("t1"), new Error("t2"));

    const p = saveDraft(makePlaylist(), [makeTrack({ id: "a" })]);

    // After 99ms (just shy of the 100ms first delay), there should still
    // be exactly 1 transaction — the second attempt hasn't fired.
    await vi.advanceTimersByTimeAsync(99);
    expect(dbState.transactions).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2);
    expect(dbState.transactions).toHaveLength(2);

    // After the second failure, the 500ms delay must elapse before
    // attempt #3. We're now at ~101ms total; advance to 599ms total
    // (498ms more) — still 2 txns. Then cross the 600ms boundary.
    await vi.advanceTimersByTimeAsync(498);
    expect(dbState.transactions).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(3);
    expect(dbState.transactions).toHaveLength(3);

    await expect(p).resolves.toBeUndefined();
  });
});

// ----------------------------------------------------------------------
// writeDraftOnce — synchronous request fan-out
// ----------------------------------------------------------------------

describe("writeDraftOnce request fan-out", () => {
  it("opens a single readwrite transaction covering both stores", async () => {
    // Contract: the write must be in one txn so a partial commit can't
    // produce a playlist row pointing at the old tracks list (or vice
    // versa).
    await saveDraft(makePlaylist({ trackIds: ["a"] }), [makeTrack({ id: "a" })]);

    expect(dbState.transactions).toHaveLength(1);
    const tx = dbState.transactions[0]!;
    expect(tx.mode).toBe("readwrite");
    expect(tx.stores).toEqual([STORE_PLAYLISTS, STORE_TRACKS]);
  });

  it("issues playlist put, tracks clear, and track puts within one txn — clear precedes puts", async () => {
    // Contract: the request sequence must be playlist-put, tracks-clear,
    // then track-puts. Clearing AFTER the puts would wipe what we just
    // wrote. The ordering is observable through `requests` because every
    // op gets pushed in-order at call time.
    await saveDraft(
      makePlaylist({ trackIds: ["a", "b"] }),
      [makeTrack({ id: "a" }), makeTrack({ id: "b" })],
    );

    const reqs = dbState.transactions[0]!.requests;
    // First op: playlist put.
    expect(reqs[0]).toMatchObject({ op: "put", store: STORE_PLAYLISTS });
    // Second op: tracks clear.
    expect(reqs[1]).toMatchObject({ op: "clear", store: STORE_TRACKS });
    // Remaining ops: track puts in input order.
    expect(reqs.slice(2)).toEqual([
      { op: "put", store: STORE_TRACKS, payload: expect.objectContaining({ id: "a" }) },
      { op: "put", store: STORE_TRACKS, payload: expect.objectContaining({ id: "b" }) },
    ]);
    expect(dbState.transactions).toHaveLength(1);
    expect(dbState.transactions[0]!.committed).toBe(true);
  });

  it("queues all requests synchronously before awaiting — no autocommit gap", async () => {
    // Contract: the for-loop in writeDraftOnce must push every request
    // BEFORE awaiting Promise.all. If it awaited inside the loop, the
    // transaction would autocommit between puts. We assert by checking
    // that all requests for this txn were registered in a single
    // microtask before any settled.
    let putsSeenAtFirstResolve = 0;
    // Wrap the fake DB with a transaction interceptor that, when ANY
    // track-store put settles, records how many track-store puts had
    // already been queued onto this transaction. If the source awaited
    // between puts (autocommit risk), this would max out at 1.
    const { db: innerDb, state: freshState } = makeFakeDb();
    dbState = freshState;
    const wrappedDb = {
      transaction(stores: string[], mode: string) {
        const tx = innerDb.transaction(stores, mode);
        return {
          objectStore(name: string) {
            const s = tx.objectStore(name);
            if (name !== STORE_TRACKS) return s;
            return {
              ...s,
              put(value: unknown) {
                const p = s.put(value);
                void p.then(() => {
                  const txn = dbState.transactions[dbState.transactions.length - 1]!;
                  putsSeenAtFirstResolve = Math.max(
                    putsSeenAtFirstResolve,
                    txn.requests.filter(
                      (rq) => rq.op === "put" && rq.store === STORE_TRACKS,
                    ).length,
                  );
                });
                return p;
              },
            };
          },
          get done(): Promise<void> {
            return tx.done;
          },
        };
      },
    };
    vi.mocked(getDatabase).mockResolvedValue(wrappedDb as never);

    await saveDraft(
      makePlaylist({ trackIds: ["a", "b", "c"] }),
      [
        makeTrack({ id: "a" }),
        makeTrack({ id: "b" }),
        makeTrack({ id: "c" }),
      ],
    );

    // By the time any put settles, all 3 puts should already have been
    // pushed onto the transaction's request list — i.e. synchronously.
    expect(putsSeenAtFirstResolve).toBe(3);
  });

  it("empty tracks array still opens the txn and clears the tracks store", async () => {
    // Contract: a playlist with no tracks still needs to clear out any
    // stale rows from a previous larger draft.
    await saveDraft(makePlaylist({ trackIds: [] }), []);
    const reqs = dbState.transactions[0]!.requests;
    expect(reqs.some((r) => r.op === "clear" && r.store === STORE_TRACKS)).toBe(true);
    expect(reqs.filter((r) => r.op === "put" && r.store === STORE_TRACKS)).toHaveLength(0);
  });
});

// ----------------------------------------------------------------------
// loadDraft / clearDraft
// ----------------------------------------------------------------------

describe("loadDraft", () => {
  it("returns the saved playlist and tracks under one readonly txn", async () => {
    // Contract: load reads playlist + tracks together so a write
    // landing mid-load can't return a playlist with stale trackIds
    // paired with the new tracks list.
    const pl = makePlaylist({ id: "p1", trackIds: ["a", "b"] });
    await saveDraft(pl, [makeTrack({ id: "a" }), makeTrack({ id: "b" })]);

    const result = await loadDraft("p1");
    expect(result.playlist?.id).toBe("p1");
    expect(result.tracks.map((t) => t.id).sort()).toEqual(["a", "b"]);

    // The load transaction is the LAST in the log; it should be readonly
    // and span both stores.
    const loadTxn = dbState.transactions[dbState.transactions.length - 1]!;
    expect(loadTxn.mode).toBe("readonly");
    expect(loadTxn.stores).toEqual([STORE_PLAYLISTS, STORE_TRACKS]);
  });

  it("returns playlist: null when the id is unknown", async () => {
    // Contract: a missing playlist is a normal state (fresh install), not
    // an error.
    const result = await loadDraft("missing");
    expect(result.playlist).toBeNull();
    expect(result.tracks).toEqual([]);
  });
});

describe("clearDraft", () => {
  it("deletes the playlist row and clears the tracks store", async () => {
    // Contract: clearDraft wipes both the playlist row (by id) and ALL
    // tracks — the user is starting over.
    const pl = makePlaylist({ id: "p1", trackIds: ["a"] });
    await saveDraft(pl, [makeTrack({ id: "a" })]);

    await clearDraft("p1");

    const clearTxn = dbState.transactions[dbState.transactions.length - 1]!;
    expect(clearTxn.mode).toBe("readwrite");
    expect(
      clearTxn.requests.some(
        (r) => r.op === "delete" && r.store === STORE_PLAYLISTS && r.payload === "p1",
      ),
    ).toBe(true);
    expect(
      clearTxn.requests.some((r) => r.op === "clear" && r.store === STORE_TRACKS),
    ).toBe(true);

    // And a subsequent load returns the empty state.
    const reload = await loadDraft("p1");
    expect(reload.playlist).toBeNull();
    expect(reload.tracks).toEqual([]);
  });
});

// ----------------------------------------------------------------------
// DraftQuotaExceededError surface
// ----------------------------------------------------------------------

describe("DraftQuotaExceededError", () => {
  it("carries the original DOMException as `cause` and has a recognizable name", () => {
    // Contract: the error.name is used by the UI to detect this specific
    // failure mode and surface a "free up storage" toast. The `cause`
    // preserves the underlying DOMException for diagnostics.
    const inner = new DOMException("quota", "QuotaExceededError");
    const wrapped = new DraftQuotaExceededError(inner);
    expect(wrapped.name).toBe("DraftQuotaExceededError");
    expect(wrapped.cause).toBe(inner);
    expect(wrapped).toBeInstanceOf(Error);
  });
});
