import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// database.ts opens IndexedDB through idb's `openDB`. We mock that single
// import so we can drive the open's success/failure shape (sync throw,
// async reject, resolve) without standing up a real IDBFactory, and
// observe the module's caching + error-wrapping contract directly.
vi.mock("idb", () => ({
  openDB: vi.fn(),
}));

import { openDB } from "idb";

const openDBMock = openDB as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  // Each test starts from a clean module state so the cached `dbPromise`
  // from a prior test can't leak across cases.
  vi.resetModules();
  openDBMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("getDatabase", () => {
  it("wraps a synchronous openDB throw as IndexedDBUnavailableError", async () => {
    // Some contexts (Safari Private, storage-gated embeds) make
    // `indexedDB` undefined, so openDB throws synchronously.
    const cause = new ReferenceError("indexedDB is not defined");
    const { openDB: mockedOpenDB } = await import("idb");
    const mock = mockedOpenDB as unknown as ReturnType<typeof vi.fn>;
    mock.mockImplementation(() => {
      throw cause;
    });

    const { getDatabase: freshGetDatabase, IndexedDBUnavailableError: FreshErr } =
      await import("./database");

    await expect(freshGetDatabase()).rejects.toBeInstanceOf(FreshErr);
    // The original failure is preserved as the cause for diagnostics.
    await expect(freshGetDatabase()).rejects.toMatchObject({ cause });
  });

  it("does not cache a synchronous failure — a later call retries", async () => {
    const { openDB: mockedOpenDB } = await import("idb");
    const mock = mockedOpenDB as unknown as ReturnType<typeof vi.fn>;
    // First call throws (IDB momentarily unavailable); second call
    // succeeds (context recovered). The module must NOT cache the
    // failure, so the second getDatabase() re-invokes openDB.
    const fakeDb = { name: "curator" };
    mock
      .mockImplementationOnce(() => {
        throw new Error("unavailable");
      })
      .mockImplementationOnce(() => Promise.resolve(fakeDb));

    const { getDatabase: freshGetDatabase, IndexedDBUnavailableError: FreshErr } =
      await import("./database");

    await expect(freshGetDatabase()).rejects.toBeInstanceOf(FreshErr);
    await expect(freshGetDatabase()).resolves.toBe(fakeDb);
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it("wraps an async openDB rejection and nulls the cache for retry", async () => {
    const { openDB: mockedOpenDB } = await import("idb");
    const mock = mockedOpenDB as unknown as ReturnType<typeof vi.fn>;
    const cause = new Error("user rejected storage");
    const fakeDb = { name: "curator" };
    // First open rejects asynchronously (e.g. storage request denied);
    // the cached promise must be dropped so the next call re-opens and
    // can succeed rather than re-handing the rejected promise.
    mock
      .mockImplementationOnce(() => Promise.reject(cause))
      .mockImplementationOnce(() => Promise.resolve(fakeDb));

    const { getDatabase: freshGetDatabase, IndexedDBUnavailableError: FreshErr } =
      await import("./database");

    // First attempt: the async rejection surfaces wrapped, preserving cause.
    await expect(freshGetDatabase()).rejects.toBeInstanceOf(FreshErr);

    // Because the cache was nulled on failure, the NEXT call re-invokes
    // openDB (now the success impl) and resolves rather than re-handing
    // the rejected promise.
    await expect(freshGetDatabase()).resolves.toBe(fakeDb);
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it("preserves the underlying cause on an async rejection", async () => {
    const { openDB: mockedOpenDB } = await import("idb");
    const mock = mockedOpenDB as unknown as ReturnType<typeof vi.fn>;
    const cause = new Error("user rejected storage");
    mock.mockImplementation(() => Promise.reject(cause));

    const { getDatabase: freshGetDatabase } = await import("./database");

    await expect(freshGetDatabase()).rejects.toMatchObject({ cause });
  });

  it("caches a successful open — repeated calls share one connection", async () => {
    const { openDB: mockedOpenDB } = await import("idb");
    const mock = mockedOpenDB as unknown as ReturnType<typeof vi.fn>;
    const fakeDb = { name: "curator" };
    mock.mockImplementation(() => Promise.resolve(fakeDb));

    const { getDatabase: freshGetDatabase } = await import("./database");

    const a = await freshGetDatabase();
    const b = await freshGetDatabase();
    expect(a).toBe(fakeDb);
    expect(b).toBe(fakeDb);
    // Cached after the first success: openDB invoked exactly once.
    expect(mock).toHaveBeenCalledTimes(1);
  });
});
