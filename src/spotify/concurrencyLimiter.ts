// FIFO awaiter queue bounding the number of pending tasks. Currently
// used by the Spotify search runner with maxInFlight=4.
//
// Why this exists alongside the apiClient pacer: the pacer serializes
// the actual HTTP at 350 ms between starts (one in-flight slot), so the
// network is never parallel. The limiter sits ABOVE the pacer and
// bounds *producer* backpressure — without it, a 5000-track ingest
// would build a 5000-deep awaiter queue inside the pacer with all the
// associated promise + closure allocations held live. 4 lets a few
// callers be in-flight at the limiter layer (queued for the pacer)
// while the rest wait at the limiter, which is dramatically cheaper.
export class ConcurrencyLimiter {
  private active = 0;
  private readonly waiters: (() => void)[] = [];

  constructor(private readonly maxInFlight: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.maxInFlight) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.waiters.push(() => {
        this.active++;
        resolve();
      });
    });
  }

  private release(): void {
    this.active--;
    const next = this.waiters.shift();
    if (next) next();
  }
}
