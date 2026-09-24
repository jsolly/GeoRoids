import type { AsteroidData } from '../../shared-types';
import type { PersistentPilot, SavedEconomy, SavedWorld } from './WorldStore';

/** Everything the engine changed since the last flush, handed over as one transaction. */
export interface WorldCheckpoint {
  economy?: SavedEconomy;
  /** The world row, only when something in it changed since the last flush. */
  world?: SavedWorld;
  sectors: ReadonlyMap<string, AsteroidData[]>;
  pilots: readonly PersistentPilot[];
}

/** The saved world, parsed and validated once before the loop starts. */
export interface LoadedWorld {
  economy?: SavedEconomy;
  world: SavedWorld | undefined;
  sectors: Map<string, AsteroidData[]>;
  pilots: PersistentPilot[];
}

export interface WorldPersistenceDiagnostics {
  mode: 'inline' | 'worker';
  /** Requests handed over (batches and resets) that have not been applied yet. */
  pendingBatches: number;
  /** Batches committed; resets are not counted. */
  committedBatches: number;
  /** Wall time of the last commit as measured where it ran. */
  lastCommitMs?: number;
  /** Server clock (epoch ms) when the last commit was confirmed. */
  lastCommittedAt?: number;
  failed: boolean;
}

/**
 * Storage boundary for the authoritative world.
 *
 * The game loop reads the saved world exactly once through `load` and then
 * only ever calls `persist`, which must return without waiting on the disk.
 * Commit failures reach the engine through `onFailure` and are fatal: the
 * process restarts from the last committed state instead of continuing from
 * memory that no longer matches the database.
 */
export interface WorldPersistence {
  load(): LoadedWorld;
  persist(batch: WorldCheckpoint): void;
  /** Erase the saved world. Ordered after any batch handed over before it. */
  reset(): void;
  onFailure(handler: (error: Error) => void): void;
  /** Resolves once every batch handed over so far has been committed or failed. */
  whenIdle(): Promise<void>;
  /** Commit whatever is still pending, then release the database. */
  shutdown(): Promise<void>;
  diagnostics(): WorldPersistenceDiagnostics;
}

/**
 * Shutdown could not get the writer thread to release the database. A thread
 * inside a synchronous SQLite call cannot be interrupted, and `process.exit`
 * would wait for it, so the process must end itself another way.
 */
export class WorldWriterUnreleasedError extends Error {
  override readonly name = 'WorldWriterUnreleasedError';

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

/** True when `error`, one of its causes, or an aggregate member says the writer never released. */
export function includesUnreleasedWriter(error: unknown, depth = 0): boolean {
  if (!(error instanceof Error) || depth > 8) {
    return false;
  }
  if (error instanceof WorldWriterUnreleasedError) {
    return true;
  }
  if (
    error instanceof AggregateError &&
    error.errors.some((member) => includesUnreleasedWriter(member, depth + 1))
  ) {
    return true;
  }
  return includesUnreleasedWriter(error.cause, depth + 1);
}

/** Commit bookkeeping every adapter reports the same way on /health. */
export class CommitStats {
  private committedBatches = 0;
  private lastCommitMs: number | undefined;
  private lastCommittedAt: number | undefined;

  recordCommit(durationMs: number): void {
    this.committedBatches++;
    this.lastCommitMs = durationMs;
    this.lastCommittedAt = Date.now();
  }

  diagnostics(
    mode: WorldPersistenceDiagnostics['mode'],
    pendingBatches: number,
    failed: boolean
  ): WorldPersistenceDiagnostics {
    return {
      mode,
      pendingBatches,
      committedBatches: this.committedBatches,
      ...(this.lastCommitMs !== undefined ? { lastCommitMs: this.lastCommitMs } : {}),
      ...(this.lastCommittedAt !== undefined ? { lastCommittedAt: this.lastCommittedAt } : {}),
      failed,
    };
  }
}
