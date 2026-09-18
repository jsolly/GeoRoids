import { Worker } from 'node:worker_threads';
import { WorldStore } from './WorldStore';
import {
  CommitStats,
  type LoadedWorld,
  type WorldCheckpoint,
  type WorldPersistence,
  type WorldPersistenceDiagnostics,
} from './worldPersistence';
import {
  deserializeWorkerError,
  type WorldStoreWorkerReply,
  type WorldStoreWorkerRequest,
} from './worldStoreWorkerProtocol';

/**
 * Railway stops a service ten seconds after SIGTERM. Transports get two
 * seconds before this; leave room after it for the log flush.
 */
const SHUTDOWN_TIMEOUT_MS = 5_000;
/** A batch that has not committed after this long is a hung worker, not a slow disk. */
const BATCH_STALL_TIMEOUT_MS = 30_000;
const STALL_WATCH_INTERVAL_MS = 5_000;
/** The engine coalesces flushes while one is pending; more than this means it is not draining. */
const MAX_PENDING_REQUESTS = 4;

/**
 * `terminate()` cannot interrupt a worker inside a synchronous SQLite call,
 * so a wedged writer must not be able to hold the process open past its
 * shutdown budget; the process exit reclaims the thread either way.
 */
function terminateWithin(worker: Worker, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const deadline = setTimeout(resolve, timeoutMs);
    deadline.unref();
    const settle = (): void => {
      clearTimeout(deadline);
      resolve();
    };
    worker.terminate().then(settle, settle);
  });
}

interface PendingRequest {
  type: 'persist' | 'reset';
  /** Monotonic time the request was handed over, for the stall watchdog. */
  postedAt: number;
}

/**
 * `WorldPersistence` whose SQLite writer lives on a worker thread.
 *
 * The game thread opens the database once to load the saved world, then only
 * ever hands batches to the worker, so a commit and its fsync can never block
 * a simulation frame. Requests are applied in order and each is answered
 * once; a failure is reported once and the adapter stays failed, matching the
 * engine's fail-closed contract. A worker that stops answering is a failure
 * too: pending requests are watched, so the loop can never keep trusting
 * memory behind a dead writer.
 */
export class WorkerWorldPersistence implements WorldPersistence {
  private worker: Worker | undefined;
  private watchdog: NodeJS.Timeout | undefined;
  private nextRequestId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly idleWaiters: Array<() => void> = [];
  private readonly stats = new CommitStats();
  private failure: Error | undefined;
  private failureHandler: ((error: Error) => void) | undefined;
  private closing: Promise<void> | undefined;
  private readonly stallTimeoutMs: number;

  constructor(
    private readonly path: string,
    options: { stallTimeoutMs?: number } = {}
  ) {
    if (path === ':memory:') {
      throw new Error('An in-memory world cannot be shared with a worker thread');
    }
    this.stallTimeoutMs = options.stallTimeoutMs ?? BATCH_STALL_TIMEOUT_MS;
  }

  /**
   * Read the saved world on this thread, then start the writer. Starting it
   * here, once the loading connection is closed, surfaces a worker that
   * cannot open the database before the first player joins.
   */
  load(): LoadedWorld {
    const store = new WorldStore(this.path);
    let loaded: LoadedWorld;
    try {
      loaded = store.load();
    } finally {
      store.close();
    }
    this.ensureWorker();
    return loaded;
  }

  persist(batch: WorldCheckpoint): void {
    this.send({
      type: 'persist',
      id: this.nextRequestId++,
      world: batch.world,
      sectors: batch.sectors,
      pilots: [...batch.pilots],
    });
  }

  reset(): void {
    this.send({ type: 'reset', id: this.nextRequestId++ });
  }

  onFailure(handler: (error: Error) => void): void {
    this.failureHandler = handler;
    if (this.failure) {
      handler(this.failure);
    }
  }

  whenIdle(): Promise<void> {
    if (this.pending.size === 0) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.idleWaiters.push(resolve);
    });
  }

  /** Commits everything handed over, then rejects if any request ever failed. */
  shutdown(): Promise<void> {
    if (this.closing !== undefined) {
      return this.closing;
    }
    this.stopWatchdog();
    const worker = this.worker;
    const failed = (): Promise<void> =>
      this.failure ? Promise.reject(this.failure) : Promise.resolve();
    if (!worker) {
      this.closing = failed();
      return this.closing;
    }
    if (this.failure) {
      this.closing = terminateWithin(worker, SHUTDOWN_TIMEOUT_MS).then(failed);
      return this.closing;
    }
    this.closing = new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => {
        void worker.terminate();
        reject(
          new Error('World store worker did not close in time; pending world writes were lost')
        );
      }, SHUTDOWN_TIMEOUT_MS);
      worker.once('exit', () => {
        clearTimeout(deadline);
        resolve();
      });
      worker.postMessage({
        type: 'shutdown',
        id: this.nextRequestId++,
      } satisfies WorldStoreWorkerRequest);
    }).then(failed);
    return this.closing;
  }

  diagnostics(): WorldPersistenceDiagnostics {
    return this.stats.diagnostics('worker', this.pending.size, this.failure !== undefined);
  }

  private send(request: Exclude<WorldStoreWorkerRequest, { type: 'shutdown' }>): void {
    if (this.failure) {
      throw this.failure;
    }
    if (this.closing !== undefined) {
      throw new Error('World persistence is shutting down');
    }
    if (this.pending.size >= MAX_PENDING_REQUESTS) {
      this.fail(new Error('World store worker is not keeping up with world batches'));
      throw this.failure;
    }
    this.pending.set(request.id, { type: request.type, postedAt: globalThis.performance.now() });
    this.ensureWorker().postMessage(request);
  }

  private ensureWorker(): Worker {
    if (this.worker) {
      return this.worker;
    }
    // The worker file is TypeScript like the rest of the server; tsx loads it
    // the same way the entrypoint is loaded, under Node and under Vitest.
    const worker = new Worker(new URL('./worldStoreWorker.ts', import.meta.url), {
      name: 'world-store',
      workerData: { path: this.path },
      execArgv: ['--import', 'tsx'],
    });
    worker.on('message', (reply: WorldStoreWorkerReply) => this.receive(reply));
    worker.on('error', (error: unknown) =>
      this.fail(
        error instanceof Error ? error : new Error(`World store worker error: ${String(error)}`)
      )
    );
    worker.on('exit', (code) => {
      // Only shutdown ends the worker on purpose; any other exit, even a clean
      // one, leaves requests unanswered.
      if (this.closing === undefined) {
        this.fail(new Error(`World store worker exited unexpectedly with code ${code}`));
      }
    });
    this.worker = worker;
    this.watchdog = setInterval(() => this.failIfStalled(), STALL_WATCH_INTERVAL_MS);
    this.watchdog.unref();
    return worker;
  }

  private failIfStalled(): void {
    let oldest = Number.POSITIVE_INFINITY;
    for (const { postedAt } of this.pending.values()) {
      oldest = Math.min(oldest, postedAt);
    }
    const waitedMs = globalThis.performance.now() - oldest;
    if (waitedMs <= this.stallTimeoutMs) {
      return;
    }
    this.fail(
      new Error(`World store worker unresponsive; a batch has waited ${Math.round(waitedMs)} ms`)
    );
    void this.worker?.terminate();
  }

  private stopWatchdog(): void {
    if (this.watchdog) {
      clearInterval(this.watchdog);
      this.watchdog = undefined;
    }
  }

  private receive(reply: WorldStoreWorkerReply): void {
    switch (reply.type) {
      case 'done': {
        const request = this.pending.get(reply.id);
        this.pending.delete(reply.id);
        if (request?.type === 'persist') {
          this.stats.recordCommit(reply.durationMs);
        }
        this.settleIdle();
        return;
      }
      case 'failed':
        if (reply.id !== undefined) {
          this.pending.delete(reply.id);
        }
        this.fail(deserializeWorkerError(reply.error));
        return;
      default:
        this.fail(new Error(`Unknown world store reply ${JSON.stringify(reply)}`));
    }
  }

  private settleIdle(): void {
    if (this.pending.size > 0) {
      return;
    }
    for (const resolve of this.idleWaiters.splice(0)) {
      resolve();
    }
  }

  private fail(error: Error): void {
    if (this.failure) {
      return;
    }
    this.failure = error;
    this.stopWatchdog();
    this.pending.clear();
    this.settleIdle();
    this.failureHandler?.(error);
  }
}
