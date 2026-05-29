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

  it("cancelling an in-flight task is a no-op (cancelByTag only affects pending)", async () => {
    const queue = new IntervalQueue({ intervalMs: 50 });
    let releaseTask: (v: string) => void = () => undefined;
    const taskPromise = new Promise<string>((resolve) => {
      releaseTask = resolve;
    });
    const p = queue.enqueue(() => taskPromise, { tag: "doomed" });
    await vi.advanceTimersByTimeAsync(0);

    // Task is now in flight, not pending.
    expect(queue.cancelByTag("doomed")).toBe(0);

    releaseTask("done");
    expect(await p).toBe("done");
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

