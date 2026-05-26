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
      const worker = new AudioParserWorker();
      worker.addEventListener("message", (event) =>
        this.onMessage(worker, event as MessageEvent<ParseResponse>),
      );
      worker.addEventListener("error", () => this.onWorkerError(worker));
      this.workers.push(worker);
      this.availableWorkers.push(worker);
    }
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

  private onWorkerError(worker: Worker): void {
    const pending = this.pendingByWorker.get(worker);
    if (pending) {
      this.pendingByWorker.delete(worker);
      pending.reject(new Error("Audio parser worker crashed"));
    }
    this.availableWorkers.push(worker);
    this.drain();
  }

  private drain(): void {
    while (this.queue.length > 0 && this.availableWorkers.length > 0) {
      const next = this.queue.shift()!;
      const worker = this.availableWorkers.shift()!;
      this.pendingByWorker.set(worker, next.pending);
      worker.postMessage(next.request);
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
}

const pool = new AudioParserPool();

export function parseAudioInPool(file: File): Promise<ParsedFields> {
  return pool.parse(file);
}
