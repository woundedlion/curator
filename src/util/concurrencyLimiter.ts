// FIFO awaiter queue bounding the number of pending tasks. Used by
// callers that genuinely benefit from a parallelism cap — currently the
// cover-art probe pool (enrichment/) and the ingest pipeline (ingest/).
// The Spotify search runner intentionally does NOT use this: its
// requests serialize at the apiClient's IntervalQueue pacer regardless,
// so a producer-side cap doesn't change throughput.
//
// Lives in `util/` because both current consumers are cross-cutting —
// the original location under `spotify/` was a historical artifact of
// where the primitive first appeared, not a domain dependency.
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
