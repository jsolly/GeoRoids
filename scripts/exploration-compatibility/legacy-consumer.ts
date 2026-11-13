import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import process from 'node:process';
import { GameEngine } from '../../server/core/GameEngine';
import { InlineWorldPersistence } from '../../server/world/InlineWorldPersistence';
import { readSavedWorld } from '../../server/world/savedWorld';
import { WorldStore } from '../../server/world/WorldStore';
import { validExploration } from '../../shared/exploration';

// The compatibility lever copies this driver into a disposable extraction of
// the pinned legacy source. These imports must resolve to that real consumer.
const [action, path, coordinate] = process.argv.slice(2);
if ((action !== 'read' && action !== 'reveal') || !path || !isAbsolute(path)) {
  throw new Error('Expected legacy action and absolute synthetic database path');
}
const store = new WorldStore(path);
try {
  if (action === 'reveal') {
    const x = Number(coordinate);
    if (!Number.isFinite(x)) {
      throw new Error('Expected finite survey coordinate');
    }
    const engine = new GameEngine(83, undefined, new InlineWorldPersistence(store));
    engine.revealArea({ x, y: 62.5 }, 1);
    engine.checkpointWorld();
    engine.stopGameLoop();
  }
  const loaded = store.load();
  const world: unknown = loaded.world;
  if (
    world === null ||
    typeof world !== 'object' ||
    !('exploration' in world) ||
    !validExploration(world.exploration)
  ) {
    throw new Error('The supplied source is not a real legacy atlas reader');
  }
  const metadata = readSavedWorld(world);
  const progressDigest = createHash('sha256')
    .update(
      JSON.stringify({
        seed: metadata.seed,
        startedAt: metadata.startedAt,
        generation: metadata.generation,
        furnaces: metadata.civicModules,
        pilots: loaded.pilots,
        economy: loaded.economy,
        sectors: [...loaded.sectors].sort(([a], [b]) => a.localeCompare(b)),
      })
    )
    .digest('hex');
  process.stdout.write(`${JSON.stringify({ exploration: world.exploration, progressDigest })}\n`);
} finally {
  store.close();
}
