// Unit tests for the shared IntervalQueue. Both the Spotify api
// client and the MusicBrainz client build on this primitive, so a
// regression here would affect every rate-limited code path.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IntervalQueue, RequestCancelledError } from "./intervalQueue";

describe("IntervalQueue", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs the first task immediately and gates subsequent tasks by intervalMs", async () => {
    const queue = new IntervalQueue({ intervalMs: 100 });
    const order: string[] = [];

    const p1 = queue.enqueue(async () => {
      order.push("a");
      return "a";
    });
    const p2 = queue.enqueue(async () => {
      order.push("b");
      return "b";
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(["a"]);

    await vi.advanceTimersByTimeAsync(50);
    expect(order).toEqual(["a"]);

    await vi.advanceTimersByTimeAsync(60);
    expect(order).toEqual(["a", "b"]);

    expect(await p1).toBe("a");
    expect(await p2).toBe("b");
  });

  it("resolves the promise returned by enqueue with the task's result", async () => {
    const queue = new IntervalQueue({ intervalMs: 10 });
    const p = queue.enqueue(async () => 42);
    await vi.advanceTimersByTimeAsync(0);
    expect(await p).toBe(42);
  });

  it("rejects the promise when the task throws", async () => {
    const queue = new IntervalQueue({ intervalMs: 10 });
    const p = queue.enqueue(async () => {
      throw new Error("boom");
    });
    // Attach the rejection-expectation before advancing the timers
    // so the promise has a catch handler when the task's reject runs.
    const expectation = expect(p).rejects.toThrow("boom");
    await vi.advanceTimersByTimeAsync(0);
    await expectation;
  });

  it("continues draining after a task throws", async () => {
    const queue = new IntervalQueue({ intervalMs: 10 });
    const ran: string[] = [];

    const p1 = queue.enqueue(async () => {
      throw new Error("first fails");
    });
    const failure = expect(p1).rejects.toThrow("first fails");

    const p2 = queue.enqueue(async () => {
      ran.push("second");
      return "ok";
    });

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(10);

    await failure;
    expect(await p2).toBe("ok");
    expect(ran).toEqual(["second"]);
  });

  it("notifies the observer on subscribe and again as depth changes", async () => {
    const queue = new IntervalQueue({ intervalMs: 50 });
    const depths: number[] = [];
    const unobserve = queue.observe((d) => depths.push(d));

    expect(depths[0]).toBe(0);

    const p1 = queue.enqueue(async () => "a");
    const p2 = queue.enqueue(async () => "b");

    // At some point depth was non-zero (after push, before drain
    // finishes). The exact intermediate values race between enqueue
    // and drain notifications.
    expect(depths.some((d) => d > 0)).toBe(true);

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(60);
    await Promise.all([p1, p2]);
    expect(depths.at(-1)).toBe(0);

    unobserve();
  });

  it("stops notifying after unobserve", async () => {
    const queue = new IntervalQueue({ intervalMs: 50 });
    let calls = 0;
    const unobserve = queue.observe(() => calls++);
    unobserve();
    const baseline = calls;
    const p = queue.enqueue(async () => "a");
    await vi.advanceTimersByTimeAsync(0);
    await p;
    expect(calls).toBe(baseline);
  });

  it("counts in-flight tasks in depth (single task running is depth=1)", async () => {
    const queue = new IntervalQueue({ intervalMs: 10 });
    const depths: number[] = [];
    queue.observe((d) => depths.push(d));

    let resolveTask: (v: string) => void = () => undefined;
    const taskPromise = new Promise<string>((resolve) => {
      resolveTask = resolve;
    });

    const p = queue.enqueue(() => taskPromise);

    // After enqueue, before resolving: task is in-flight, depth=1.
    await vi.advanceTimersByTimeAsync(0);
    expect(depths.some((d) => d === 1)).toBe(true);

    resolveTask("done");
    await p;
    expect(depths.at(-1)).toBe(0);
  });

  it("respects nextRunAt when set via recordExternalPause (e.g. server Retry-After)", async () => {
    const queue = new IntervalQueue({ intervalMs: 10 });
    const ranAt: number[] = [];
    const startedAt = Date.now();

    queue.recordExternalPause(startedAt + 5_000);

    const p = queue.enqueue(async () => {
      ranAt.push(Date.now());
      return "ok";
    });

    // Should NOT run before the pause expires.
    await vi.advanceTimersByTimeAsync(4_000);
    expect(ranAt).toEqual([]);

    await vi.advanceTimersByTimeAsync(1_500);
    expect(ranAt[0]).toBeGreaterThanOrEqual(startedAt + 5_000);
    await p;
  });
});

// cancelByTag pulls pending entries out of the FIFO without dispatching
// them. Critically, a cancelled entry must NOT consume a rate-limit
// slot — `nextRunAt` cannot advance, otherwise a deletion storm
// would starve real callers behind phantom spacing waits.
describe("IntervalQueue.cancelByTag", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("rejects every pending task with the matching tag with RequestCancelledError", async () => {
    const queue = new IntervalQueue({ intervalMs: 100 });
    // First task starts immediately and will block draining — we need
    // tasks to sit in the pending FIFO so cancelByTag has something to
    // remove. Hold the first task open with a deferred.
    let releaseFirst: () => void = () => undefined;
    const firstDone = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const p0 = queue.enqueue(async () => {
      await firstDone;
      return "first";
    });

    await vi.advanceTimersByTimeAsync(0);
    // Now enqueue three more, two tagged "doomed", one tagged "keep".
    const p1 = queue.enqueue(async () => "a", { tag: "doomed" });
    const p2 = queue.enqueue(async () => "b", { tag: "keep" });
    const p3 = queue.enqueue(async () => "c", { tag: "doomed" });

    // Attach rejection handlers synchronously: cancelByTag rejects
    // these promises inline, so without a catch attached first the
    // rejection escapes to vitest's unhandled-rejection handler.
    const expect1 = expect(p1).rejects.toBeInstanceOf(RequestCancelledError);
    const expect3 = expect(p3).rejects.toBeInstanceOf(RequestCancelledError);
    const cancelled = queue.cancelByTag("doomed");
    expect(cancelled).toBe(2);
    await expect1;
    await expect3;

    // Release the first task and let the survivor drain.
    releaseFirst();
    await vi.advanceTimersByTimeAsync(100);
    expect(await p0).toBe("first");
    expect(await p2).toBe("b");
  });

  it("returns 0 and no-ops when no pending task matches the tag", async () => {
    const queue = new IntervalQueue({ intervalMs: 50 });
    const p = queue.enqueue(async () => "x", { tag: "real" });
    expect(queue.cancelByTag("ghost")).toBe(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(await p).toBe("x");
  });

  it("does NOT advance nextRunAt — the next real task can run immediately", async () => {
    const queue = new IntervalQueue({ intervalMs: 1_000 });

    // Block the first task so doomed/survivor sit in the FIFO.
    let releaseFirst: () => void = () => undefined;
    const firstDone = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const p0 = queue.enqueue(async () => {
      await firstDone;
    });
    await vi.advanceTimersByTimeAsync(0);

    const pDoomed = queue.enqueue(async () => "doomed", { tag: "doomed" });
    const pSurvivor = queue.enqueue(async () => "survivor");

    const doomedExpectation = expect(pDoomed).rejects.toBeInstanceOf(
      RequestCancelledError,
    );
    queue.cancelByTag("doomed");
    await doomedExpectation;

    // Finish the first task. Survivor is now next; it should observe
    // the spacing relative to the first task's start (1000 ms), NOT
    // be delayed by an extra interval per cancelled phantom.
    const firstStartedAt = Date.now();
    releaseFirst();
    await vi.advanceTimersByTimeAsync(1_000);
    await p0;
    expect(await pSurvivor).toBe("survivor");
    // Survivor ran at firstStartedAt + intervalMs, NOT
    // firstStartedAt + 2*intervalMs (which would be the bug).
    expect(Date.now()).toBe(firstStartedAt + 1_000);
  });

  it("aborts an in-flight task and counts it in the return", async () => {
    const queue = new IntervalQueue({ intervalMs: 50 });
    // The task awaits the queue-supplied AbortSignal so it surfaces
    // the cancellation via the standard signal path — same shape any
    // real `fetch`-based caller would use.
    const p = queue.enqueue(
      (signal) =>
        new Promise<string>((_, reject) => {
          if (signal.aborted) return reject(new Error("aborted"));
          signal.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        }),
      { tag: "doomed" },
    );
    const rejection = expect(p).rejects.toBeInstanceOf(RequestCancelledError);
    await vi.advanceTimersByTimeAsync(0);
    // Task is now in flight, not pending. cancelByTag aborts it via
    // the signal and the drain loop translates the resulting error
    // into the canonical RequestCancelledError.
    expect(queue.cancelByTag("doomed")).toBe(1);
    await rejection;
  });
});

// Priority lets a latency-sensitive caller (a user-triggered playback
// command) cut ahead of a deep backlog of background work (search
// enrichment) without bypassing the spacing gap or the single in-flight
// slot. Higher priority runs sooner; equal priorities stay FIFO.
describe("IntervalQueue priority", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("a higher-priority task cuts ahead of lower-priority pending tasks", async () => {
    const queue = new IntervalQueue({ intervalMs: 100 });
    const order: string[] = [];

    // Hold the first task open so the rest pile up behind it in the
    // pending FIFO.
    let releaseFirst: () => void = () => undefined;
    const firstDone = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const p0 = queue.enqueue(async () => {
      order.push("first");
      await firstDone;
    });
    await vi.advanceTimersByTimeAsync(0);

    // Two background (normal) tasks, then a high-priority one enqueued
    // LAST — it must still jump ahead of the two normals.
    const pA = queue.enqueue(async () => void order.push("a"), {
      priority: 0,
    });
    const pB = queue.enqueue(async () => void order.push("b"), {
      priority: 0,
    });
    const pHigh = queue.enqueue(async () => void order.push("high"), {
      priority: 1,
    });

    releaseFirst();
    await vi.advanceTimersByTimeAsync(300);
    await Promise.all([p0, pA, pB, pHigh]);

    expect(order).toEqual(["first", "high", "a", "b"]);
  });

  it("equal-priority tasks preserve FIFO order", async () => {
    const queue = new IntervalQueue({ intervalMs: 100 });
    const order: string[] = [];

    let releaseFirst: () => void = () => undefined;
    const firstDone = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const p0 = queue.enqueue(async () => {
      await firstDone;
    });
    await vi.advanceTimersByTimeAsync(0);

    const ps = ["a", "b", "c"].map((id) =>
      queue.enqueue(async () => void order.push(id), { priority: 5 }),
    );

    releaseFirst();
    await vi.advanceTimersByTimeAsync(300);
    await Promise.all([p0, ...ps]);

    expect(order).toEqual(["a", "b", "c"]);
  });

  it("priority does not preempt the in-flight task or skip the spacing gap", async () => {
    const queue = new IntervalQueue({ intervalMs: 100 });
    const order: string[] = [];

    // First (normal) task starts immediately and runs to completion,
    // advancing nextRunAt by 100ms.
    const p0 = queue.enqueue(async () => void order.push("first"));
    await vi.advanceTimersByTimeAsync(0);

    // A high-priority task now must still wait out the 100ms gap — it
    // cannot fire before the spacing window elapses.
    const pHigh = queue.enqueue(async () => void order.push("high"), {
      priority: 1,
    });
    await vi.advanceTimersByTimeAsync(50);
    expect(order).toEqual(["first"]);

    await vi.advanceTimersByTimeAsync(60);
    expect(order).toEqual(["first", "high"]);
    await Promise.all([p0, pHigh]);
  });
});

// The post-wait guard is defense-in-depth against the race where an
// entity (e.g. a track) is deleted AFTER enqueue but BEFORE the
// explicit cancelByTag fires. A guard returning false must reject the
// caller with RequestCancelledError and — critically — must NOT
// consume a rate-limit slot, so the next legitimate task starts
// immediately.
describe("IntervalQueue post-wait guard", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("rejects the caller with RequestCancelledError when the guard returns false post-wait", async () => {
    const queue = new IntervalQueue({ intervalMs: 10 });
    const run = vi.fn(async () => "ok");
    const p = queue.enqueue(run, { guard: () => false });
    // Attach the expectation before advancing fake timers — otherwise
    // the rejection fires unhandled between enqueue and `await`.
    const expectation = expect(p).rejects.toBeInstanceOf(RequestCancelledError);
    await vi.advanceTimersByTimeAsync(0);
    await expectation;
    // No HTTP call (or other work) should have been performed.
    expect(run).not.toHaveBeenCalled();
  });

  it("does NOT advance nextRunAt when the guard rejects — the next task runs immediately", async () => {
    const queue = new IntervalQueue({ intervalMs: 1_000 });

    // First task runs, advancing nextRunAt by 1000 ms.
    const startedAt = Date.now();
    const p0 = queue.enqueue(async () => "first");
    await vi.advanceTimersByTimeAsync(0);
    await p0;

    // Enqueue a guarded task (will reject) and a normal task.
    const guardedRun = vi.fn(async () => "guarded");
    const pGuarded = queue.enqueue(guardedRun, { guard: () => false });
    const guardedExpectation = expect(pGuarded).rejects.toBeInstanceOf(
      RequestCancelledError,
    );
    const pNext = queue.enqueue(async () => "next");

    // Wait the 1000 ms spacing window so guarded pops.
    await vi.advanceTimersByTimeAsync(1_000);
    await guardedExpectation;
    expect(guardedRun).not.toHaveBeenCalled();

    // The next task should run on the SAME tick — the guard rejection
    // did not push nextRunAt forward by another intervalMs.
    expect(await pNext).toBe("next");
    expect(Date.now()).toBe(startedAt + 1_000);
  });

  it("guard returning true lets the task run normally", async () => {
    const queue = new IntervalQueue({ intervalMs: 10 });
    const p = queue.enqueue(async () => 42, { guard: () => true });
    await vi.advanceTimersByTimeAsync(0);
    expect(await p).toBe(42);
  });

  it("a throwing guard rejects only its own task and the queue keeps draining", async () => {
    // A guard is contracted to be a pure predicate, but a buggy one that
    // throws must not escape the drain loop and strand every other queued
    // task's awaiter forever. The throwing task rejects with its error;
    // subsequent tasks still run.
    const queue = new IntervalQueue({ intervalMs: 10 });
    const boom = new Error("guard blew up");
    const thrower = vi.fn(async () => "thrower");
    const pThrow = queue.enqueue(thrower, {
      guard: () => {
        throw boom;
      },
    });
    const throwExpectation = expect(pThrow).rejects.toBe(boom);
    const pNext = queue.enqueue(async () => "next");

    await vi.advanceTimersByTimeAsync(10);
    await throwExpectation;
    // The throwing guard's task never ran its work...
    expect(thrower).not.toHaveBeenCalled();
    // ...and the queue did NOT wedge — the following task drains normally.
    expect(await pNext).toBe("next");
  });

  it("guard is re-evaluated post-wait, not at enqueue time", async () => {
    const queue = new IntervalQueue({ intervalMs: 100 });

    // First task occupies the queue and triggers the spacing wait.
    const p0 = queue.enqueue(async () => "first");
    await vi.advanceTimersByTimeAsync(0);
    await p0;

    // Enqueue a task whose guard is initially true but flips to false
    // before the spacing window elapses — simulating a deletion that
    // races with the queue popping.
    let alive = true;
    const run = vi.fn(async () => "ran");
    const p = queue.enqueue(run, { guard: () => alive });
    const expectation = expect(p).rejects.toBeInstanceOf(RequestCancelledError);

    // Flip the guard while the task is still waiting in spacing.
    alive = false;

    await vi.advanceTimersByTimeAsync(100);
    await expectation;
    expect(run).not.toHaveBeenCalled();
  });
});

// ─── Persistence (localStorage-backed nextRunAt) ─────────────────────
//
// The Spotify queue persists `nextRunAt` so a reload doesn't let a fresh
// tab replay a burst that just earned a 429. node lacks `localStorage`,
// so this suite stubs an in-memory one. The `persistedCapMs` clamp is the
// load-bearing anti-deadlock guard (a corrupt far-future write must not
// strand the queue), so it gets a dedicated test.
describe("IntervalQueue persistence", () => {
  const KEY = "test.queue.nextAllowedAt";
  const BASE = 1_700_000_000_000;
  let backing: Map<string, string>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE);
    backing = new Map();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => backing.get(k) ?? null,
      setItem: (k: string, v: string) => {
        backing.set(k, String(v));
      },
      removeItem: (k: string) => {
        backing.delete(k);
      },
      clear: () => backing.clear(),
      key: (i: number) => Array.from(backing.keys())[i] ?? null,
      get length() {
        return backing.size;
      },
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("gates the first task until a persisted future timestamp elapses", async () => {
    backing.set(KEY, String(BASE + 5_000));
    const queue = new IntervalQueue({ intervalMs: 100, persistKey: KEY });
    const run = vi.fn(async () => "ok");
    const p = queue.enqueue(run);

    await vi.advanceTimersByTimeAsync(0);
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(1);
    expect(await p).toBe("ok");
  });

  it("clamps a persisted timestamp beyond persistedCapMs so a corrupt write can't deadlock the queue", async () => {
    // A bogus far-future write (ms/s mix-up, corruption) must not strand
    // the queue for hours — the read clamps it to now + cap.
    backing.set(KEY, String(BASE + 9_999_999));
    const queue = new IntervalQueue({
      intervalMs: 100,
      persistKey: KEY,
      persistedCapMs: 60_000,
    });
    expect(queue.nextRunAtTimestamp).toBe(BASE + 60_000);

    const run = vi.fn(async () => "ok");
    const p = queue.enqueue(run);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(run).toHaveBeenCalledTimes(1);
    await p;
  });

  it("ignores a persisted timestamp already in the past (first task runs immediately)", async () => {
    backing.set(KEY, String(BASE - 1_000));
    const queue = new IntervalQueue({ intervalMs: 100, persistKey: KEY });
    expect(queue.nextRunAtTimestamp).toBe(0);

    const run = vi.fn(async () => "ok");
    const p = queue.enqueue(run);
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);
    await p;
  });

  it("ignores a corrupt (non-numeric) persisted value", () => {
    backing.set(KEY, "not-a-number");
    const queue = new IntervalQueue({ intervalMs: 100, persistKey: KEY });
    expect(queue.nextRunAtTimestamp).toBe(0);
  });

  it("persists nextRunAt after dispatching a task", async () => {
    const queue = new IntervalQueue({ intervalMs: 1_000, persistKey: KEY });
    const p = queue.enqueue(async () => "ok");
    await vi.advanceTimersByTimeAsync(0);
    await p;
    // setNextRunAt(now + intervalMs) ran during dispatch (now === BASE).
    expect(backing.get(KEY)).toBe(String(BASE + 1_000));
  });

  it("recordExternalPause persists the backoff so a fresh queue (reload) honors it", () => {
    const queue = new IntervalQueue({ intervalMs: 100, persistKey: KEY });
    queue.recordExternalPause(BASE + 30_000);
    expect(backing.get(KEY)).toBe(String(BASE + 30_000));

    // Reload: a new instance reads the persisted value back (within cap).
    const reloaded = new IntervalQueue({ intervalMs: 100, persistKey: KEY });
    expect(reloaded.nextRunAtTimestamp).toBe(BASE + 30_000);
  });

  it("reset() clears the persisted timestamp (setNextRunAt(0) removes the key)", () => {
    backing.set(KEY, String(BASE + 5_000));
    const queue = new IntervalQueue({ intervalMs: 100, persistKey: KEY });
    expect(backing.get(KEY)).toBe(String(BASE + 5_000));

    queue.reset();
    expect(backing.has(KEY)).toBe(false);
    expect(queue.nextRunAtTimestamp).toBe(0);
  });

  it("does not touch localStorage when no persistKey is configured", async () => {
    const queue = new IntervalQueue({ intervalMs: 100 });
    queue.recordExternalPause(BASE + 5_000);
    const p = queue.enqueue(async () => "ok");
    await vi.advanceTimersByTimeAsync(5_000);
    await p;
    expect(backing.size).toBe(0);
  });
});

