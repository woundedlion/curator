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
  /**
   * Optional per-task timeout safeguard. When set (a positive,
   * finite number of milliseconds), a task whose `run()` promise
   * does not settle within `taskTimeoutMs` of dispatch is forcibly
   * failed: its caller rejects with `TaskTimeoutError`, its
   * AbortController is aborted (so a hung `fetch` is torn down on
   * the wire), its in-flight slot is released, and the drain loop
   * continues to the next task. This guards against an upstream
   * request that never resolves wedging the entire queue forever.
   *
   * DEFAULT is `undefined` = no timeout, preserving the original
   * behavior for existing consumers and tests. The timer is always
   * cleared when a task settles normally so no timer leaks and no
   * late rejection can fire after a successful completion.
   */
  taskTimeoutMs?: number;
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
  /**
   * Scheduling priority. Higher runs sooner: a newly-enqueued task
   * jumps ahead of every PENDING task with a lower priority, so a
   * latency-sensitive caller (e.g. a user-triggered playback command)
   * doesn't sit behind a deep backlog of background work (e.g. search
   * enrichment). Defaults to 0. Equal priorities preserve FIFO order.
   *
   * Priority only reorders the WAITING queue; it does not shorten the
   * inter-task spacing, bypass the circuit breaker, or pre-empt the
   * single task already in flight (at most one lower-priority task
   * runs ahead — the one already dispatched).
   */
  priority?: number;
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

/**
 * Thrown to the awaiter of a queued task when the task's `run()`
 * promise fails to settle within the queue's configured
 * `taskTimeoutMs`. Distinct from `RequestCancelledError` (which
 * signals "no longer relevant") — a timeout means the work WAS
 * relevant but the upstream call hung. Callers may choose to treat
 * it as a transient network failure (retry/back off) rather than
 * silently dropping it.
 */
export class TaskTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Task timed out after ${timeoutMs}ms`);
    this.name = "TaskTimeoutError";
  }
}

type Task<T> = {
  run: (signal: AbortSignal) => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
  tag: string | undefined;
  guard: (() => boolean) | undefined;
  priority: number;
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
  private readonly taskTimeoutMs: number | undefined;
  private readonly pending: Task<unknown>[] = [];
  private readonly inFlightSlots = new Set<InFlightSlot>();
  private draining = false;
  private nextRunAt: number;
  private observers = new Set<QueueDepthObserver>();

  constructor(options: IntervalQueueOptions) {
    this.intervalMs = options.intervalMs;
    this.persistKey = options.persistKey;
    this.persistedCapMs = options.persistedCapMs ?? 60_000;
    // Only honor a positive, finite timeout; anything else (0, NaN,
    // negative) disables the safeguard to preserve default behavior.
    this.taskTimeoutMs =
      typeof options.taskTimeoutMs === "number" &&
      Number.isFinite(options.taskTimeoutMs) &&
      options.taskTimeoutMs > 0
        ? options.taskTimeoutMs
        : undefined;
    this.nextRunAt = this.persistKey
      ? readPersistedFutureTimestamp(this.persistKey, this.persistedCapMs)
      : 0;
  }

  /**
   * Number of tasks currently in flight. Single source of truth:
   * the size of `inFlightSlots`. (Previously mirrored by a manual
   * counter that needed a `Math.max(0, …)` clamp to survive reset
   * races — the Set can't go negative, so the clamp is gone.)
   */
  get inFlight(): number {
    return this.inFlightSlots.size;
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
        priority: options.priority ?? 0,
      };
      this.insertByPriority(task as Task<unknown>);
      this.notify();
      void this.drain();
    });
  }

  /**
   * Insert into the pending FIFO honoring priority: the task lands
   * before the first waiting task of strictly-lower priority, which
   * keeps higher priorities ahead while preserving arrival order among
   * equal priorities (we never cut in front of an equal-priority task).
   * O(n) scan — n is the queue depth, which stays small under the
   * 334ms pacer.
   */
  private insertByPriority(task: Task<unknown>): void {
    const idx = this.pending.findIndex((t) => t.priority < task.priority);
    if (idx === -1) {
      this.pending.push(task);
    } else {
      this.pending.splice(idx, 0, task);
    }
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
        if (task.guard) {
          let guardPassed: boolean;
          try {
            guardPassed = task.guard();
          } catch (error) {
            // A guard is contracted to be a pure predicate, but defend
            // against a throwing one: reject just this task and keep
            // draining. Letting the exception escape the loop would
            // strand every other queued task's awaiter forever and halt
            // the queue (the awaiting promise never settles).
            task.reject(error);
            this.notify();
            continue;
          }
          if (!guardPassed) {
            task.reject(new RequestCancelledError());
            this.notify();
            continue;
          }
        }
        this.setNextRunAt(Date.now() + this.intervalMs);
        const slot: InFlightSlot = {
          tag: task.tag,
          controller: new AbortController(),
          cancelled: false,
        };
        this.inFlightSlots.add(slot);
        this.notify();
        // Optional per-task timeout. When configured, race the task's
        // run() against a timer. If the timer wins, abort the slot's
        // controller (tearing down a hung fetch) and resolve the race
        // with a sentinel so the loop rejects the caller with
        // TaskTimeoutError and keeps draining instead of awaiting a
        // promise that never settles. The timer is ALWAYS cleared in
        // `finally` so it can't leak or fire a late rejection after a
        // normal settle.
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
        let timedOut = false;
        try {
          let value: unknown;
          if (this.taskTimeoutMs === undefined) {
            value = await task.run(slot.controller.signal);
          } else {
            const timeoutMs = this.taskTimeoutMs;
            const timeoutPromise = new Promise<typeof TIMEOUT_SENTINEL>(
              (resolve) => {
                timeoutHandle = setTimeout(() => {
                  timedOut = true;
                  // Abort the in-flight controller so the underlying
                  // request is torn down on the wire, mirroring the
                  // cancelByTag teardown path.
                  slot.controller.abort();
                  resolve(TIMEOUT_SENTINEL);
                }, timeoutMs);
              },
            );
            const runPromise = task.run(slot.controller.signal);
            // If the timer wins, the run promise stays pending (or
            // later rejects with an AbortError because we aborted its
            // controller). Attach a no-op catch so that late settle
            // doesn't surface as an unhandled rejection — the caller
            // has already been rejected with TaskTimeoutError.
            runPromise.catch(() => undefined);
            const raced = await Promise.race([runPromise, timeoutPromise]);
            if (raced === TIMEOUT_SENTINEL) {
              task.reject(new TaskTimeoutError(timeoutMs));
              // Skip the resolve/cancel handling below — the timeout
              // already rejected the caller. `finally` releases the
              // slot and clears the timer.
              continue;
            }
            value = raced;
          }
          task.resolve(value as never);
        } catch (error) {
          // When `cancelByTag` aborted us, the underlying fetch throws
          // an AbortError. Translate it to the canonical
          // `RequestCancelledError` so callers (and toasts) see the
          // same typed signal regardless of whether the cancel landed
          // pre-dispatch or mid-flight.
          //
          // A timeout also aborts the controller, so a run() that
          // rejects with its own AbortError AFTER the timer fired must
          // surface as TaskTimeoutError, not RequestCancelledError —
          // `timedOut` disambiguates (the caller was already rejected
          // above for the sentinel path; here we cover the case where
          // run() loses the race by rejecting first).
          if (timedOut) {
            task.reject(new TaskTimeoutError(this.taskTimeoutMs!));
          } else {
            task.reject(slot.cancelled ? new RequestCancelledError() : error);
          }
        } finally {
          if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
          this.inFlightSlots.delete(slot);
          this.notify();
        }
      }
    } finally {
      this.draining = false;
    }
  }
}

// Unique sentinel used to distinguish "the timeout timer won the race"
// from any value a task's run() might legitimately resolve with.
const TIMEOUT_SENTINEL: unique symbol = Symbol("IntervalQueue.timeout");

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readPersistedFutureTimestamp(key: string, capMs: number): number {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return 0;
    const parsed = Number.parseInt(raw, 10);
    // One clock read so the guard and the cap window are computed against
    // the same `now` (mirrors circuitBreaker's read-once discipline).
    const now = Date.now();
    if (!Number.isFinite(parsed) || parsed <= now) return 0;
    return Math.min(parsed, now + capMs);
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
