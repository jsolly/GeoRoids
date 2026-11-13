import { WorldStore } from '../../server/world/WorldStore';
import { WORLD } from '../../shared/world';

/** A persisted fixture has an explicit identity before adding legacy progress. */
export function createPrivateWorld(path: string, seed = 82): WorldStore {
  const store = new WorldStore(path, { intent: 'private' });
  store.checkpoint({ seed, startedAt: 1, generation: WORLD.generation }, new Map(), []);
  return store;
}
