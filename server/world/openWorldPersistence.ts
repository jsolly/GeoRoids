import { WorkerWorldPersistence } from './WorkerWorldPersistence';
import { WorldStore } from './WorldStore';
import type { WorldPersistence } from './worldPersistence';

/**
 * A file-backed world commits on a worker thread so the game loop never waits
 * on the disk. An in-memory database cannot cross threads, so the integration
 * runners' `:memory:` world commits inline instead.
 */
export function openWorldPersistence(path: string): WorldPersistence {
  return path === ':memory:' ? new WorldStore(path) : new WorkerWorldPersistence(path);
}
