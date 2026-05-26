import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RateLimitedQueue } from "./rateLimitedQueue";

describe("RateLimitedQueue", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs the first task immediately and gates subsequent tasks by intervalMs", async () => {
    const queue = new RateLimitedQueue(100);
    const order: string[] = [];

    const p1 = queue.enqueue(async () => {
      order.push("a");
      return "a";
    });
    const p2 = queue.enqueue(async () => {
      order.push("b");
      return "b";
    });

    // Flush microtasks for the first immediate task.
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(["a"]);

    // Second task should still be waiting.
    await vi.advanceTimersByTimeAsync(50);
    expect(order).toEqual(["a"]);

    // Once the interval elapses, the second task runs.
    await vi.advanceTimersByTimeAsync(60);
    expect(order).toEqual(["a", "b"]);

    expect(await p1).toBe("a");
    expect(await p2).toBe("b");
  });

  it("resolves the promise returned by enqueue with the task's result", async () => {
    const queue = new RateLimitedQueue(10);
    const p = queue.enqueue(async () => 42);
    await vi.advanceTimersByTimeAsync(0);
    expect(await p).toBe(42);
  });

  it("rejects the promise when the task throws", async () => {
    const queue = new RateLimitedQueue(10);
    const p = queue.enqueue(async () => {
      throw new Error("boom");
    });
    // Attach the rejection-expectation before advancing the timers, so the
    // promise has a catch handler the moment the task's reject runs. Without
    // this, the rejection fires unhandled and vitest flags it.
    const expectation = expect(p).rejects.toThrow("boom");
    await vi.advanceTimersByTimeAsync(0);
    await expectation;
  });

  it("continues draining after a task throws", async () => {
    const queue = new RateLimitedQueue(10);
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
    const queue = new RateLimitedQueue(50);
    const depths: number[] = [];
    const unobserve = queue.observe((d) => depths.push(d));

    // Initial notification on subscribe.
    expect(depths[0]).toBe(0);

    const p1 = queue.enqueue(async () => "a");
    const p2 = queue.enqueue(async () => "b");

    // We don't assert a specific intermediate depth — enqueue notifies after
    // push, but drain notifies again after shift, so the most-recent depth
    // races between the synchronous calls. We DO know that at some point the
    // observer saw a non-zero depth, and that after draining it returns to 0.
    expect(depths.some((d) => d > 0)).toBe(true);

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(60);
    await Promise.all([p1, p2]);
    expect(depths.at(-1)).toBe(0);

    unobserve();
  });

  it("stops notifying after unobserve", async () => {
    const queue = new RateLimitedQueue(50);
    let calls = 0;
    const unobserve = queue.observe(() => calls++);
    unobserve();
    const baseline = calls;
    const p = queue.enqueue(async () => "a");
    await vi.advanceTimersByTimeAsync(0);
    await p;
    expect(calls).toBe(baseline);
  });
});
