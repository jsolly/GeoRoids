import { performance } from 'node:perf_hooks';
import type { WorldStore } from './WorldStore';
import {
  CommitStats,
  type LoadedWorld,
  type WorldCheckpoint,
  type WorldPersistence,
  type WorldPersistenceDiagnostics,
} from './worldPersistence';

/**
 * `WorldPersistence` that commits on the calling thread.
 *
 * For in-memory worlds only: tests and the integration runners have no disk
 * to wait on, and a `:memory:` database could not be shared with a worker.
 * A failed commit fails the adapter for good, like the worker adapter, so the
 * engine's fail-closed contract is the same under both.
 */
export class InlineWorldPersistence implements WorldPersistence {
  private readonly stats = new CommitStats();
  private failure: Error | undefined;
  private failureHandler: ((error: Error) => void) | undefined;

  constructor(private readonly store: WorldStore) {}

  load(): LoadedWorld {
    return this.store.load();
  }

  persist(batch: WorldCheckpoint): void {
    if (this.failure) {
      throw this.failure;
    }
    const started = performance.now();
    try {
      this.store.checkpoint(batch.world, batch.sectors, batch.pilots);
    } catch (error) {
      this.fail(
        error instanceof Error ? error : new Error('World commit failed', { cause: error })
      );
      throw error;
    }
    this.stats.recordCommit(performance.now() - started);
  }

  reset(): void {
    if (this.failure) {
      throw this.failure;
    }
    this.store.reset();
  }

  onFailure(handler: (error: Error) => void): void {
    this.failureHandler = handler;
    if (this.failure) {
      handler(this.failure);
    }
  }

  whenIdle(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    this.store.close();
    return this.failure ? Promise.reject(this.failure) : Promise.resolve();
  }

  diagnostics(): WorldPersistenceDiagnostics {
    return this.stats.diagnostics('inline', 0, this.failure !== undefined);
  }

  private fail(error: Error): void {
    if (this.failure) {
      return;
    }
    this.failure = error;
    this.failureHandler?.(error);
  }
}
