type Task<T> = {
  run: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
};

export type QueueObserver = (depth: number) => void;

export class RateLimitedQueue {
  private readonly intervalMs: number;
  private readonly pending: Task<unknown>[] = [];
  private inFlight = 0;
  private running = false;
  private lastRunAt = 0;
  private observers: Set<QueueObserver> = new Set();

  constructor(intervalMs: number) {
    this.intervalMs = intervalMs;
  }

  // Total tasks the queue is responsible for right now — waiting in `pending`
  // plus any task currently executing. Reporting only `pending.length` gives
  // a misleading zero while the single in-flight task runs, which made the
  // toolbar's "Enriching · N remaining" indicator never appear.
  private depth(): number {
    return this.pending.length + this.inFlight;
  }

  observe(observer: QueueObserver): () => void {
    this.observers.add(observer);
    observer(this.depth());
    return () => this.observers.delete(observer);
  }

  enqueue<T>(run: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.pending.push({ run, resolve, reject } as Task<unknown>);
      this.notify();
      this.drain();
    });
  }

  private notify(): void {
    const depth = this.depth();
    for (const observer of this.observers) observer(depth);
  }

  private msUntilNextRun(): number {
    const elapsed = Date.now() - this.lastRunAt;
    return Math.max(0, this.intervalMs - elapsed);
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.pending.length > 0) {
        const wait = this.msUntilNextRun();
        if (wait > 0) await sleep(wait);
        const task = this.pending.shift()!;
        this.inFlight++;
        this.lastRunAt = Date.now();
        this.notify();
        try {
          const value = await task.run();
          task.resolve(value);
        } catch (error) {
          task.reject(error);
        } finally {
          this.inFlight--;
          this.notify();
        }
      }
    } finally {
      this.running = false;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
