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
};

const DEFAULT_POOL_SIZE = 4;

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

  private ensureStarted(): void {
    if (this.started) return;
    this.started = true;
    const size = decidePoolSize();
    for (let i = 0; i < size; i++) {
      this.spawnWorker();
    }
  }

  private spawnWorker(): Worker {
    const worker = new AudioParserWorker();
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
    if (!pending || pending.id !== event.data.id) return;
    this.pendingByWorker.delete(worker);
    this.availableWorkers.push(worker);
    if (event.data.ok) pending.resolve(event.data.fields);
    else pending.reject(new Error(event.data.error));
    this.drain();
  }

  // A worker `error` event usually means the worker is now dead — terminate
  // and replace it instead of returning it to the pool, otherwise the next
  // drain() would postMessage to a corpse and queue a permanent stall.
  private onWorkerError(worker: Worker): void {
    const pending = this.pendingByWorker.get(worker);
    if (pending) {
      this.pendingByWorker.delete(worker);
      pending.reject(new Error("Audio parser worker crashed"));
    }
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
      try {
        worker.postMessage(next.request);
      } catch (error) {
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
    this.ensureStarted();
    return new Promise<ParsedFields>((resolve, reject) => {
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
