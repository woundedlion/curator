// Tests for the AudioParserPool — the Web Worker pool that runs
// music-metadata off the main thread. The Vite `?worker` import is
// mocked with a hand-rolled FakeWorker so tests can drive message /
// error / timing deterministically without a real Worker runtime.
//
// Focus areas (previously untested): the response happy path, crash →
// respawn, the parse TIMEOUT → respawn (a hung worker that never replies
// or crashes), id desync, and terminate rejecting in-flight requests.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ParseRequest, ParseResponse } from "./audioParser.worker";

const { FakeWorker } = vi.hoisted(() => {
  type Listener = (event: unknown) => void;
  class FakeWorker {
    static instances: FakeWorker[] = [];
    // When set, the Worker constructor throws — simulates CSP-blocked /
    // unsupported-browser worker spawns so the zero-spawn path can be
    // exercised.
    static throwOnConstruct = false;
    posted: ParseRequest[] = [];
    terminated = false;
    // When set, the NEXT postMessage throws (then clears) — simulates a
    // structured-clone / detached-worker failure so the drain() recovery
    // path can be exercised.
    throwOnNextPost = false;
    private messageListeners: Listener[] = [];
    private errorListeners: Listener[] = [];
    constructor() {
      if (FakeWorker.throwOnConstruct) {
        throw new Error("Worker construction blocked");
      }
      FakeWorker.instances.push(this);
    }
    addEventListener(type: string, cb: Listener): void {
      if (type === "message") this.messageListeners.push(cb);
      else if (type === "error") this.errorListeners.push(cb);
    }
    postMessage(msg: ParseRequest): void {
      if (this.throwOnNextPost) {
        this.throwOnNextPost = false;
        throw new Error("postMessage boom");
      }
      this.posted.push(msg);
    }
    terminate(): void {
      this.terminated = true;
    }
    fireMessage(data: ParseResponse): void {
      for (const cb of this.messageListeners) cb({ data });
    }
    fireError(): void {
      for (const cb of this.errorListeners) cb(new Event("error"));
    }
  }
  return { FakeWorker };
});

vi.mock("./audioParser.worker.ts?worker", () => ({ default: FakeWorker }));

import { parseAudioInPool, shutdownAudioParserPool } from "./audioParserPool";

function fakeFile(name = "t.mp3"): File {
  return new File([new Uint8Array([1, 2, 3])], name, { type: "audio/mpeg" });
}

/** The worker the most recent parse() was dispatched to (last to receive a postMessage). */
function workerWithLatestPost(): InstanceType<typeof FakeWorker> {
  const withPosts = FakeWorker.instances.filter((w) => w.posted.length > 0);
  return withPosts[withPosts.length - 1]!;
}

beforeEach(() => {
  FakeWorker.instances.length = 0;
  FakeWorker.throwOnConstruct = false;
});

afterEach(() => {
  shutdownAudioParserPool();
  vi.useRealTimers();
});

describe("AudioParserPool", () => {
  it("resolves a parse with the worker's fields response", async () => {
    const p = parseAudioInPool(fakeFile());
    const worker = workerWithLatestPost();
    const id = worker.posted[0]!.id;
    worker.fireMessage({ id, ok: true, fields: { title: "Hello" } });
    await expect(p).resolves.toEqual({ title: "Hello" });
  });

  it("rejects with the worker's error message on an ok:false response", async () => {
    const p = parseAudioInPool(fakeFile());
    const worker = workerWithLatestPost();
    const id = worker.posted[0]!.id;
    worker.fireMessage({ id, ok: false, error: "corrupt header" });
    await expect(p).rejects.toThrow("corrupt header");
  });

  it("rejects on an id desync (response id != request id)", async () => {
    const p = parseAudioInPool(fakeFile());
    const worker = workerWithLatestPost();
    worker.fireMessage({ id: 999_999, ok: true, fields: {} });
    await expect(p).rejects.toThrow("desynchronized");
  });

  it("REGRESSION: a hung worker (no reply, no crash) is timed out and replaced", async () => {
    vi.useFakeTimers();
    const before = FakeWorker.instances.length;
    const p = parseAudioInPool(fakeFile());
    const captured = captureRejection(p);
    const worker = workerWithLatestPost();
    // Worker never replies and never errors — only the timeout saves us.
    await vi.advanceTimersByTimeAsync(30_000);
    const error = await captured;
    expect(String(error)).toContain("timed out");
    // The wedged worker was terminated and a replacement spawned, so the
    // pool didn't permanently lose a slot.
    expect(worker.terminated).toBe(true);
    expect(FakeWorker.instances.length).toBeGreaterThan(before);
  });

  it("a worker crash rejects its pending and the pool recovers for the next parse", async () => {
    const p1 = parseAudioInPool(fakeFile());
    const captured = captureRejection(p1);
    const worker = workerWithLatestPost();
    worker.fireError();
    expect(String(await captured)).toContain("crashed");
    // A replacement worker was spawned — the next parse still completes.
    const p2 = parseAudioInPool(fakeFile());
    const worker2 = workerWithLatestPost();
    const id = worker2.posted[worker2.posted.length - 1]!.id;
    worker2.fireMessage({ id, ok: true, fields: { title: "Recovered" } });
    await expect(p2).resolves.toEqual({ title: "Recovered" });
  });

  it("a throwing postMessage rejects the request, replaces the worker, and recovers", async () => {
    // First parse forces the lazy pool to spawn and completes normally
    // so we have a known set of live workers.
    const warm = parseAudioInPool(fakeFile());
    const w1 = workerWithLatestPost();
    w1.fireMessage({ id: w1.posted[0]!.id, ok: true, fields: { title: "ok" } });
    await expect(warm).resolves.toEqual({ title: "ok" });

    const before = FakeWorker.instances.length;
    // Arm every live worker to throw on its next postMessage — whichever
    // one drain() picks will hit the failure branch.
    for (const w of FakeWorker.instances) w.throwOnNextPost = true;

    const p = parseAudioInPool(fakeFile());
    // drain() catches the throw synchronously, so the promise is already
    // rejected by the time parse() returns.
    await expect(p).rejects.toThrow(/postMessage boom/);

    // The wedged worker was discarded and a replacement spawned, so the
    // pool didn't permanently lose a slot — a subsequent parse still
    // completes on a healthy worker.
    expect(FakeWorker.instances.length).toBeGreaterThan(before);
    // Disarm any still-armed siblings (the pool has several workers) so
    // the recovery parse below lands on a worker that won't re-throw.
    for (const w of FakeWorker.instances) w.throwOnNextPost = false;
    const p2 = parseAudioInPool(fakeFile());
    const w2 = workerWithLatestPost();
    w2.fireMessage({
      id: w2.posted[w2.posted.length - 1]!.id,
      ok: true,
      fields: { title: "after recovery" },
    });
    await expect(p2).resolves.toEqual({ title: "after recovery" });
  });

  it("REGRESSION: the first parse() REJECTS (does not hang) when no worker can spawn", async () => {
    // Every Worker construction throws (CSP-blocked / unsupported browser),
    // so the pool spawns zero workers. The request that triggered the spawn
    // is pushed AFTER ensureStarted() in the buggy code, so it would never
    // be failed and its promise would hang forever. Use fake timers and a
    // racing timeout to assert the promise actually settles (rejects).
    vi.useFakeTimers();
    FakeWorker.throwOnConstruct = true;
    const p = parseAudioInPool(fakeFile());
    const captured = captureRejection(p);
    const settled = Promise.race([
      captured.then((e) => ({ kind: "settled" as const, error: e })),
      // If parse() hangs, this timeout wins and the assertion below fails.
      new Promise<{ kind: "hung" }>((resolve) =>
        setTimeout(() => resolve({ kind: "hung" }), 60_000),
      ),
    ]);
    await vi.advanceTimersByTimeAsync(60_000);
    const outcome = await settled;
    expect(outcome.kind).toBe("settled");
    if (outcome.kind === "settled") {
      expect(String(outcome.error)).toContain("unavailable");
    }
    expect(FakeWorker.instances.length).toBe(0);
  });

  it("terminate() rejects every in-flight request", async () => {
    const p = parseAudioInPool(fakeFile());
    const captured = captureRejection(p);
    shutdownAudioParserPool();
    expect(String(await captured)).toContain("terminated");
  });
});

// Capture a rejection without an unhandled-rejection warning under fake
// timers (the rejection settles during advanceTimersByTimeAsync).
function captureRejection(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => new Error("expected rejection but resolved"),
    (e) => e,
  );
}
