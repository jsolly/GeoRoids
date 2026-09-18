import { Worker } from 'node:worker_threads';
import { WorldStore } from './WorldStore';
import type {
  LoadedWorld,
  WorldCheckpoint,
  WorldPersistence,
  WorldPersistenceDiagnostics,
} from './worldPersistence';
import {
  deserializeWorkerError,
  type WorldStoreWorkerReply,
  type WorldStoreWorkerRequest,
} from './worldStoreWorkerProtocol';

/** Railway stops a service ten seconds after SIGTERM; leave room for the sockets to close. */
const SHUTDOWN_TIMEOUT_MS = 8_000;

/**
 * `WorldPersistence` whose SQLite writer lives on a worker thread.
 *
 * The game thread opens the database once to load the saved world, then only
 * ever hands batches to the worker, so a commit and its fsync can never block
 * a simulation frame. Batches are applied in order; a failure is reported once
 * and the adapter stays failed, matching the engine's fail-closed contract.
 */
export class WorkerWorldPersistence implements WorldPersistence {
  private worker: Worker | undefined;
  private nextRequestId = 1;
  private readonly pending = new Set<number>();
  private readonly idleWaiters: Array<() => void> = [];
  private committedBatches = 0;
  private lastCommitMs: number | undefined;
  private lastCommittedAt: number | undefined;
  private failure: Error | undefined;
  private failureHandler: ((error: Error) => void) | undefined;
  private closing: Promise<void> | undefined;

  constructor(private readonly path: string) {
    if (path === ':memory:') {
      throw new Error('An in-memory world cannot be shared with a worker thread');
    }
  }

  load(): LoadedWorld {
    const store = new WorldStore(this.path);
    try {
      return store.load();
    } finally {
      store.close();
    }
  }

  persist(batch: WorldCheckpoint): void {
    this.send({
      type: 'persist',
      id: this.nextRequestId++,
      world: batch.world,
      sectors: [...batch.sectors.entries()],
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

  /** Commits everything handed over, then rejects if any batch ever failed. */
  shutdown(): Promise<void> {
    if (this.closing !== undefined) {
      return this.closing;
    }
    const worker = this.worker;
    const failed = (): Promise<void> =>
      this.failure ? Promise.reject(this.failure) : Promise.resolve();
    if (!worker) {
      this.closing = failed();
      return this.closing;
    }
    if (this.failure) {
      this.closing = worker.terminate().then(failed);
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
    return {
      mode: 'worker',
      pendingBatches: this.pending.size,
      committedBatches: this.committedBatches,
      ...(this.lastCommitMs !== undefined ? { lastCommitMs: this.lastCommitMs } : {}),
      ...(this.lastCommittedAt !== undefined ? { lastCommittedAt: this.lastCommittedAt } : {}),
      failed: this.failure !== undefined,
    };
  }

  private send(request: WorldStoreWorkerRequest): void {
    if (this.failure) {
      throw this.failure;
    }
    if (this.closing !== undefined) {
      throw new Error('World persistence is shutting down');
    }
    if (request.type === 'persist') {
      this.pending.add(request.id);
    }
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
      if (this.closing === undefined && code !== 0) {
        this.fail(new Error(`World store worker exited with code ${code}`));
      }
    });
    this.worker = worker;
    return worker;
  }

  private receive(reply: WorldStoreWorkerReply): void {
    switch (reply.type) {
      case 'committed':
        this.pending.delete(reply.id);
        this.committedBatches++;
        this.lastCommitMs = reply.durationMs;
        this.lastCommittedAt = Date.now();
        this.settleIdle();
        return;
      case 'failed':
        if (reply.id !== undefined) {
          this.pending.delete(reply.id);
        }
        this.fail(deserializeWorkerError(reply.error));
        return;
      case 'ready':
      case 'reset':
      case 'closed':
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
    this.pending.clear();
    this.settleIdle();
    this.failureHandler?.(error);
  }
}
