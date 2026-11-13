import { InlineWorldPersistence } from './InlineWorldPersistence';
import { WorkerWorldPersistence } from './WorkerWorldPersistence';
import { WorldStore } from './WorldStore';
import type { WorldOpenIntent, WorldPersistence } from './worldPersistence';

/**
 * A file-backed world commits on a worker thread so the game loop never waits
 * on the disk. An in-memory database cannot cross threads, so the integration
 * runners' `:memory:` world commits inline instead.
 */
export function openWorldPersistence(
  path: string,
  options: { intent?: WorldOpenIntent } = {}
): WorldPersistence {
  return path === ':memory:'
    ? new InlineWorldPersistence(new WorldStore(path, options))
    : new WorkerWorldPersistence(path, options);
}
