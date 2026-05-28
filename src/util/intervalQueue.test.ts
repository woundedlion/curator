// Unit tests for the shared IntervalQueue. Both the Spotify api
// client and the MusicBrainz client build on this primitive, so a
// regression here would affect every rate-limited code path.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IntervalQueue } from "./intervalQueue";

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
