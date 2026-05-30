import AudioParserWorker from "./audioParser.worker.ts?worker";
import type {
  ParseRequest,
  ParseResponse,
  ParsedFields,
} from "./audioParser.worker";

type Pending = {
  id: number;
  resolve: (fields: ParsedFields) => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
};

const DEFAULT_POOL_SIZE = 4;

// Cap a single file's parse. music-metadata can hang (not throw, not
// crash) on a truncated or pathological container — no message, no error
// event ever fires, so the worker would sit in `pendingByWorker` forever,
// permanently removing one slot from the pool and leaving the caller's
// promise unsettled. The timeout converts that into a normal failure:
// reject the request, terminate + respawn the wedged worker, drain on.
// Generous so a genuinely large file on a slow machine still completes.
const PARSE_TIMEOUT_MS = 30_000;

function decidePoolSize(): number {
  const hw =
    typeof navigator !== "undefined"
      ? navigator.hardwareConcurrency
      : undefined;
  if (typeof hw !== "number" || hw < 1) return DEFAULT_POOL_SIZE;
  return Math.min(Math.max(2, hw), 8);
}

class AudioParserPool {
  private readonly workers: Worker[] = [];
  private readonly availableWorkers: Worker[] = [];
  private readonly pendingByWorker = new Map<Worker, Pending>();
  private readonly queue: { request: ParseRequest; pending: Pending }[] = [];
  private nextId = 1;
  private started = false;

  // Returns true once at least one worker is live. Returns false when the
  // spawn yielded zero workers, so parse() can reject the triggering
  // request instead of leaving its promise to hang.
  private ensureStarted(): boolean {
    if (this.started) return true;
    this.started = true;
    const size = decidePoolSize();
    let spawned = 0;
    for (let i = 0; i < size; i++) {
      if (this.spawnWorker() !== null) spawned++;
    }
    if (spawned === 0) {
      // CSP-blocked workers, sandboxed iframes, or unsupported browsers
      // surface here as zero successful spawns. Reset `started` so a
      // future parse() retries the spawn; already-queued pending requests
      // are failed here, and parse() rejects its own (not-yet-queued)
      // request so callers see a real error instead of hanging.
      this.started = false;
      this.failQueuedRequests("Audio parser workers are unavailable in this browser");
      return false;
    }
    return true;
  }

  private failQueuedRequests(message: string): void {
    while (this.queue.length > 0) {
      const next = this.queue.shift()!;
      next.pending.reject(new Error(message));
    }
  }

  private spawnWorker(): Worker | null {
    let worker: Worker;
    try {
      worker = new AudioParserWorker();
    } catch (error) {
      console.error("AudioParserPool: failed to spawn worker", error);
      return null;
    }
    worker.addEventListener("message", (event) =>
      this.onMessage(worker, event as MessageEvent<ParseResponse>),
    );
    worker.addEventListener("error", () => this.onWorkerError(worker));
    this.workers.push(worker);
    this.availableWorkers.push(worker);
    return worker;
  }

  private onMessage(worker: Worker, event: MessageEvent<ParseResponse>): void {
    const pending = this.pendingByWorker.get(worker);
    // A worker is always returned to the available pool when it sends a
    // message, even if the message refers to a request id we no longer
    // recognize (e.g. a late reply after a timeout/terminate). Without
    // this the worker would be silently stuck off the pool forever.
    this.pendingByWorker.delete(worker);
    if (pending?.timer) clearTimeout(pending.timer);
    this.availableWorkers.push(worker);

    if (!pending) {
      console.warn(
        "AudioParserPool: message from worker with no pending request",
        event.data,
      );
    } else if (pending.id !== event.data.id) {
      console.warn(
        "AudioParserPool: response id mismatch",
        { expected: pending.id, got: event.data.id },
      );
      pending.reject(new Error("Audio parser worker desynchronized"));
    } else if (event.data.ok) {
      pending.resolve(event.data.fields);
    } else {
      pending.reject(new Error(event.data.error));
    }
    this.drain();
  }

  // A worker `error` event usually means the worker is now dead — terminate
  // and replace it instead of returning it to the pool, otherwise the next
  // drain() would postMessage to a corpse and queue a permanent stall.
  private onWorkerError(worker: Worker): void {
    const pending = this.pendingByWorker.get(worker);
    if (pending) {
      this.pendingByWorker.delete(worker);
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(new Error("Audio parser worker crashed"));
    }
    this.discardWorker(worker);
    if (this.started) this.spawnWorker();
    this.drain();
  }

  // A worker that neither replies nor crashes within PARSE_TIMEOUT_MS is
  // treated like a crash: fail the request and replace the worker so its
  // pool slot isn't lost to a wedged parse.
  private onWorkerTimeout(worker: Worker, pending: Pending): void {
    // Guard against a reply that raced in just before the timer fired —
    // if this pending is no longer the one assigned to the worker, the
    // response path already handled it.
    if (this.pendingByWorker.get(worker) !== pending) return;
    this.pendingByWorker.delete(worker);
    pending.reject(new Error("Audio parser worker timed out"));
    this.discardWorker(worker);
    if (this.started) this.spawnWorker();
    this.drain();
  }

  private discardWorker(worker: Worker): void {
    try {
      worker.terminate();
    } catch {
      // ignore — worker may already be dead
    }
    const workersIdx = this.workers.indexOf(worker);
    if (workersIdx !== -1) this.workers.splice(workersIdx, 1);
    const availableIdx = this.availableWorkers.indexOf(worker);
    if (availableIdx !== -1) this.availableWorkers.splice(availableIdx, 1);
  }

  private drain(): void {
    while (this.queue.length > 0 && this.availableWorkers.length > 0) {
      const next = this.queue.shift()!;
      const worker = this.availableWorkers.shift()!;
      this.pendingByWorker.set(worker, next.pending);
      next.pending.timer = setTimeout(
        () => this.onWorkerTimeout(worker, next.pending),
        PARSE_TIMEOUT_MS,
      );
      try {
        worker.postMessage(next.request);
      } catch (error) {
        clearTimeout(next.pending.timer);
        this.pendingByWorker.delete(worker);
        const message =
          error instanceof Error ? error.message : "postMessage failed";
        next.pending.reject(new Error(`Audio parser worker: ${message}`));
        this.discardWorker(worker);
        if (this.started) this.spawnWorker();
      }
    }
  }

  parse(file: File): Promise<ParsedFields> {
    return new Promise<ParsedFields>((resolve, reject) => {
      // Spawn before queueing so a zero-spawn failure rejects THIS request
      // rather than hanging it: ensureStarted() only fails already-queued
      // pendings, so a request pushed afterwards would never be settled.
      if (!this.ensureStarted()) {
        reject(
          new Error("Audio parser workers are unavailable in this browser"),
        );
        return;
      }
      const id = this.nextId++;
      const pending: Pending = { id, resolve, reject };
      this.queue.push({ request: { id, file }, pending });
      this.drain();
    });
  }

  terminate(): void {
    for (const worker of this.workers) worker.terminate();
    for (const { pending } of this.queue) {
      pending.reject(new Error("Audio parser pool was terminated"));
    }
    for (const pending of this.pendingByWorker.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(new Error("Audio parser pool was terminated"));
    }
    this.workers.length = 0;
    this.availableWorkers.length = 0;
    this.pendingByWorker.clear();
    this.queue.length = 0;
    this.started = false;
  }
}

const pool = new AudioParserPool();

export function parseAudioInPool(file: File): Promise<ParsedFields> {
  return pool.parse(file);
}

export function shutdownAudioParserPool(): void {
  pool.terminate();
}
