import { describe, expect, it } from "vitest";
import { ConcurrencyLimiter } from "./concurrencyLimiter";

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("ConcurrencyLimiter", () => {
  it("never exceeds the configured concurrency", async () => {
    const limiter = new ConcurrencyLimiter(2);
    let inFlight = 0;
    let maxInFlight = 0;

    const tasks = Array.from({ length: 10 }, () =>
      limiter.run(async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
      }),
    );

    await Promise.all(tasks);
    expect(maxInFlight).toBeLessThanOrEqual(2);
    expect(maxInFlight).toBeGreaterThan(0);
  });

  it("starts a waiting task only after a slot is freed", async () => {
    const limiter = new ConcurrencyLimiter(1);
    const gate1 = deferred<void>();
    const gate2 = deferred<void>();
    let started2 = false;

    const t1 = limiter.run(async () => {
      await gate1.promise;
    });
    const t2 = limiter.run(async () => {
      started2 = true;
      await gate2.promise;
    });

    // Yield to the event loop; t2 should not have started yet because t1 holds the slot.
    await Promise.resolve();
    await Promise.resolve();
    expect(started2).toBe(false);

    gate1.resolve();
    await t1;
    await Promise.resolve();
    expect(started2).toBe(true);

    gate2.resolve();
    await t2;
  });

  it("propagates task return values", async () => {
    const limiter = new ConcurrencyLimiter(1);
    await expect(limiter.run(async () => 7)).resolves.toBe(7);
  });

  it("releases a slot when the task throws", async () => {
    const limiter = new ConcurrencyLimiter(1);

    await expect(
      limiter.run(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    // Subsequent task must still be able to acquire — i.e. release ran even on failure.
    await expect(limiter.run(async () => "ok")).resolves.toBe("ok");
  });

  it("permits as many concurrent tasks as the limit when called with limit=N", async () => {
    const limiter = new ConcurrencyLimiter(3);
    const gates = [deferred<void>(), deferred<void>(), deferred<void>()];
    let active = 0;

    const tasks = gates.map((g) =>
      limiter.run(async () => {
        active++;
        await g.promise;
        active--;
      }),
    );

    // Let all three acquire their slots.
    await Promise.resolve();
    await Promise.resolve();
    expect(active).toBe(3);

    for (const g of gates) g.resolve();
    await Promise.all(tasks);
  });
});
