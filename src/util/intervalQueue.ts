// FIFO task queue with a minimum interval between consecutive runs.
//
// State machine for a single queue:
//
//        ┌────────────────────────────────────────────────────────────┐
//        │  `nextRunAt`: the earliest moment the next task may start. │
//        │   - On enqueue: the task joins a FIFO. If the queue isn't  │
//        │     already draining, a `drain` loop starts.               │
//        │   - On drain: sleep until `nextRunAt`, dequeue, set        │
//        │     `nextRunAt = now + intervalMs`, run the task.          │
//        │   - On task completion (success OR failure): notify        │
//        │     observers and continue the loop.                       │
//        └────────────────────────────────────────────────────────────┘
//
// Depth = waiting + in-flight. The single in-flight slot counts so an
// observer sees "1" while the only queued task is running, not a
// misleading "0".
//
// Persistence is opt-in. The Spotify path persists `nextRunAt` because
// Spotify's rolling-30s quota counts requests across page reloads;
// MusicBrainz doesn't need it (MB's 1 req/sec is rigid, no rolling
// window to honor across sessions).
//
// Used by:
//   - `src/spotify/apiClient.ts`   (with persistence + circuit breaker on top)
//   - `src/enrichment/musicbrainzClient.ts`  (no persistence, 503-retry on top)

export type QueueDepthObserver = (depth: number) => void;

export type IntervalQueueOptions = {
  /** Minimum gap between consecutive task starts. */
  intervalMs: number;
  /**
   * Optional localStorage key for persisting `nextRunAt` across page
   * reloads. When set, the queue won't fire its first task until the
   * persisted timestamp elapses. Capped on read by `persistedCapMs`
   * (default 60s) so a corrupt write can't deadlock the queue.
   */
  persistKey?: string;
  persistedCapMs?: number;
};

export type EnqueueOptions = {
  /**
   * Caller-supplied identifier for grouping tasks. Used by
   * `cancelByTag(tag)` to remove every pending task associated with
   * a given entity (e.g. a deleted track) without affecting other
   * tasks. Tags need not be unique — a single tag can correspond to
   * multiple queued tasks (e.g. Spotify search + MB enrichment for
   * the same trackId both tag with that id).
   */
  tag?: string;
  /**
   * Defense-in-depth: re-checked at run time (after the spacing
   * wait, before the task body and any outbound HTTP call). If it
   * returns false, the task is rejected with `RequestCancelledError`
   * and does NOT consume a rate-limit slot — `nextRunAt` is not
   * advanced, so the next task can run immediately. This protects
   * against the narrow window where the entity (e.g. a track) is
   * deleted AFTER enqueue and BEFORE the cancel-by-tag side effect
   * fires; without the guard the task would pop, make the HTTP call,
   * and only then discover the entity is gone.
   */
  guard?: () => boolean;
};

/**
 * Thrown to the awaiter of a queued task when the task is cancelled
 * via `cancelByTag` before it gets a chance to run. Callers that
 * wrap their work in `enqueue()` should catch this specifically and
 * treat it as "the work was no longer relevant" — not as a network
 * error, not as a user-visible failure, no toast.
 */
export class RequestCancelledError extends Error {
  constructor() {
    super("Request cancelled");
    this.name = "RequestCancelledError";
  }
}

type Task<T> = {
  run: (signal: AbortSignal) => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
  tag: string | undefined;
  guard: (() => boolean) | undefined;
};

// Track for each in-flight task so `cancelByTag` can abort the
// underlying fetch on the wire — without this, a cancelled in-flight
// request still costs a slot against Spotify's rolling 30s bucket. The
// `cancelled` flag lets the drain loop swap the resulting AbortError
// for a `RequestCancelledError` so callers see the same typed error
// from pending and in-flight cancellation paths.
type InFlightSlot = {
  tag: string | undefined;
  controller: AbortController;
  cancelled: boolean;
};

export class IntervalQueue {
  private readonly intervalMs: number;
  private readonly persistKey: string | undefined;
  private readonly persistedCapMs: number;
  private readonly pending: Task<unknown>[] = [];
  private readonly inFlightSlots = new Set<InFlightSlot>();
  private inFlight = 0;
  private draining = false;
  private nextRunAt: number;
  private observers = new Set<QueueDepthObserver>();

  constructor(options: IntervalQueueOptions) {
    this.intervalMs = options.intervalMs;
    this.persistKey = options.persistKey;
    this.persistedCapMs = options.persistedCapMs ?? 60_000;
    this.nextRunAt = this.persistKey
      ? readPersistedFutureTimestamp(this.persistKey, this.persistedCapMs)
      : 0;
  }

  /** Tasks waiting in the FIFO plus any currently running. */
  get depth(): number {
    return this.pending.length + this.inFlight;
  }

  /** Pending = waiting only. */
  get pendingCount(): number {
    return this.pending.length;
  }

  /** Earliest moment the next task may start. */
  get nextRunAtTimestamp(): number {
    return this.nextRunAt;
  }

  /**
   * Subscribe to depth changes. Fires once immediately with the
   * current depth, then on every enqueue / start / finish. Returns
   * an unsubscribe function.
   */
  observe(callback: QueueDepthObserver): () => void {
    this.observers.add(callback);
    callback(this.depth);
    return () => {
      this.observers.delete(callback);
    };
  }

  /**
   * Enqueue a task. Resolves/rejects with the task's outcome. FIFO.
   * Multiple concurrent enqueues line up in arrival order.
   *
   * An optional `tag` groups the task with others sharing the same
   * tag for cancellation via `cancelByTag` — see also
   * `RequestCancelledError`.
   */
  enqueue<T>(
    run: (signal: AbortSignal) => Promise<T>,
    options: EnqueueOptions = {},
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const task: Task<T> = {
        run,
        resolve,
        reject,
        tag: options.tag,
        guard: options.guard,
      };
      this.pending.push(task as Task<unknown>);
      this.notify();
      void this.drain();
    });
  }

  /**
   * Remove every PENDING task whose tag matches `tag` from the FIFO,
   * rejecting each one's promise with `RequestCancelledError`. Also
   * aborts every IN-FLIGHT task with the same tag — the drain loop
   * translates the resulting AbortError into `RequestCancelledError`
   * so callers see one typed error regardless of where the cancel
   * landed in the request's lifecycle.
   *
   * Aborting an in-flight `fetch` closes the connection at the
   * network layer. If the request hasn't reached Spotify's edge yet,
   * it doesn't count against the rolling-30s bucket. If it already
   * has, Spotify has already counted it — but we still benefit from
   * not waiting for a response we'd discard anyway.
   *
   * Returns the total number of tasks cancelled (pending + in-flight).
   */
  cancelByTag(tag: string): number {
    let aborted = 0;
    if (this.inFlightSlots.size > 0) {
      for (const slot of this.inFlightSlots) {
        if (slot.tag === tag && !slot.cancelled) {
          slot.cancelled = true;
          slot.controller.abort();
          aborted++;
        }
      }
    }
    if (this.pending.length === 0) {
      if (aborted > 0) this.notify();
      return aborted;
    }
    const survivors: Task<unknown>[] = [];
    const cancelled: Task<unknown>[] = [];
    for (const task of this.pending) {
      if (task.tag === tag) cancelled.push(task);
      else survivors.push(task);
    }
    if (cancelled.length === 0) {
      if (aborted > 0) this.notify();
      return aborted;
    }
    // Swap the array contents in place so any external references
    // to `pending` (there shouldn't be any, but be defensive) stay
    // valid.
    this.pending.length = 0;
    this.pending.push(...survivors);
    // Reject AFTER we've fully removed from the queue so a
    // .catch() handler that synchronously calls back into the queue
    // sees a consistent state.
    const cancelError = new RequestCancelledError();
    for (const task of cancelled) task.reject(cancelError);
    this.notify();
    return cancelled.length + aborted;
  }

  /**
   * Advance `nextRunAt` past an externally-imposed wait window. Used
   * by callers that learn the server wants us to back off (e.g.
   * Spotify 429 → use `Retry-After`). The queue stays open — tasks
   * still arrive in FIFO order — but no task starts until the new
   * timestamp elapses.
   */
  recordExternalPause(untilTimestamp: number): void {
    if (untilTimestamp > this.nextRunAt) {
      this.setNextRunAt(untilTimestamp);
    }
  }

  /**
   * Test-only: hard reset to a fresh queue. Also clears `draining` so
   * a previous test's drain loop (which may be stranded awaiting a
   * fake-time sleep that was cancelled by `vi.useRealTimers()`) can't
   * block the next test's drain from starting.
   */
  reset(): void {
    this.pending.length = 0;
    // Aborting in-flight controllers on reset is the safe default —
    // an in-flight `fetch` that resolves after a test that wiped the
    // queue would otherwise write into a torn-down store. Tests that
    // care about the next state immediately after reset see clean
    // counters; tests that don't aren't affected.
    for (const slot of this.inFlightSlots) {
      slot.cancelled = true;
      slot.controller.abort();
    }
    this.inFlightSlots.clear();
    this.inFlight = 0;
    this.draining = false;
    this.setNextRunAt(0);
    this.notify();
  }

  private notify(): void {
    const depth = this.depth;
    for (const cb of this.observers) cb(depth);
  }

  private setNextRunAt(timestamp: number): void {
    this.nextRunAt = timestamp;
    if (this.persistKey) {
      persistFutureTimestamp(this.persistKey, timestamp);
    }
  }

  private msUntilNextRun(): number {
    return Math.max(0, this.nextRunAt - Date.now());
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.pending.length > 0) {
        const wait = this.msUntilNextRun();
        if (wait > 0) await sleep(wait);
        const task = this.pending.shift()!;
        // Defense-in-depth guard check, post-wait pre-run. A task
        // whose guard fails is treated as cancelled: it does NOT
        // consume a rate-limit slot (nextRunAt isn't bumped, so the
        // next task can run immediately), no HTTP call is made, and
        // the caller's await rejects with RequestCancelledError.
        // This catches the race window between enqueue and the
        // explicit cancelByTag side effect — and a missing cancel
        // entirely would still be caught here.
        if (task.guard && !task.guard()) {
          task.reject(new RequestCancelledError());
          this.notify();
          continue;
        }
        this.inFlight++;
        this.setNextRunAt(Date.now() + this.intervalMs);
        const slot: InFlightSlot = {
          tag: task.tag,
          controller: new AbortController(),
          cancelled: false,
        };
        this.inFlightSlots.add(slot);
        this.notify();
        try {
          const value = await task.run(slot.controller.signal);
          task.resolve(value);
        } catch (error) {
          // When `cancelByTag` aborted us, the underlying fetch throws
          // an AbortError. Translate it to the canonical
          // `RequestCancelledError` so callers (and toasts) see the
          // same typed signal regardless of whether the cancel landed
          // pre-dispatch or mid-flight.
          task.reject(
            slot.cancelled ? new RequestCancelledError() : error,
          );
        } finally {
          this.inFlightSlots.delete(slot);
          this.inFlight--;
          this.notify();
        }
      }
    } finally {
      this.draining = false;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readPersistedFutureTimestamp(key: string, capMs: number): number {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return 0;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed <= Date.now()) return 0;
    return Math.min(parsed, Date.now() + capMs);
  } catch {
    return 0;
  }
}

function persistFutureTimestamp(key: string, timestamp: number): void {
  try {
    if (timestamp <= Date.now()) {
      localStorage.removeItem(key);
    } else {
      localStorage.setItem(key, String(timestamp));
    }
  } catch {
    // best-effort
  }
}
