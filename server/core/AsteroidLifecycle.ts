import type { AsteroidData } from '../../shared-types';
import type { AsteroidManager } from './AsteroidManager';
import type { AsteroidLifecycleInputs } from './types';

/** Complete explicit memory commands; regional unload and mining retain distinct transitions. */
export class AsteroidLifecycle {
  constructor(private readonly inputs: AsteroidLifecycleInputs) {}

  insert(asteroid: AsteroidData): void {
    this.inputs.rocks.addAsteroid(asteroid);
    this.inputs.probes.registerAsteroid(asteroid);
  }

  remove(asteroidId: string): AsteroidData | undefined {
    const removed = this.inputs.rocks.removeAsteroid(asteroidId);
    if (removed) {
      this.inputs.crawlers.escapeDestroyedHost(
        removed,
        this.inputs.rocks.spatialIndex(),
        this.inputs.currentFrame()
      );
    }
    this.inputs.probes.unregister(asteroidId);
    if (removed?.probe) {
      removed.probe = null;
    }
    return removed;
  }

  update(
    asteroidId: string,
    updates: Parameters<AsteroidManager['updateAsteroid']>[1]
  ): AsteroidData | undefined {
    const updated = this.inputs.rocks.updateAsteroid(asteroidId, updates);
    if (!updated) {
      return undefined;
    }
    this.inputs.probes.registerAsteroid(updated);
    return updated;
  }

  /** Called by the manager after all split fragments enter its live index. */
  afterDestruction(rock: AsteroidData): void {
    this.inputs.crawlers.escapeDestroyedHost(
      rock,
      this.inputs.rocks.spatialIndex(),
      this.inputs.currentFrame()
    );
  }
}
