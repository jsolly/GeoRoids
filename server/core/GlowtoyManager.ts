import { GLOWTOY, type ShipLight, shipIlluminates } from '../../shared/glowtoy';
import { WORLD } from '../../shared/world';
import type { AsteroidData, Position } from '../../shared-types';
import type { AsteroidSpatialIndex } from '../world/AsteroidSpatialIndex';
import { spatialQueryBounds } from '../world/spatialQueryBounds';
import type { EntityManager } from './EntityManager';
import type { LootManager } from './LootManager';

interface GlowtoyInputs {
  actors: Pick<EntityManager, 'getAllEntities'>;
  field: Pick<AsteroidSpatialIndex, 'queryMany'>;
  points: Pick<LootManager, 'spawnPoints'>;
  markFieldDirty: () => void;
}

/** Owns frame cadence and transient light sources; charge/reveals stay on persistent rocks. */
export class GlowtoyManager {
  private sources: Position[] = [];

  constructor(private readonly inputs: GlowtoyInputs) {}

  advance(frame: number): void {
    if (frame % GLOWTOY.tickFrames !== 0) {
      return;
    }
    const lights = this.inputs.actors
      .getAllEntities()
      .filter((pilot) => pilot.health > 0 && !pilot.exploding);
    const nearby = this.inputs.field.queryMany(
      lights.map((pilot) => spatialQueryBounds(pilot.position, WORLD.interestRadius))
    );
    this.sources = advanceGlowtoys(nearby, lights, (position) => {
      this.inputs.points.spawnPoints(position, GLOWTOY.cachePoints);
      this.inputs.markFieldDirty();
    });
  }

  lightSources(): readonly Position[] {
    return this.sources;
  }

  clear(): void {
    this.sources = [];
  }
}

/** Charge and first-reveal state are stored on the supplied persistent rock rows. */
export function advanceGlowtoys(
  rocks: readonly AsteroidData[],
  lights: readonly ShipLight[],
  reveal: (position: Position) => void
): Position[] {
  const bright: Position[] = [];
  let count = 0;
  for (const rock of rocks) {
    const glow = rock.glowtoy;
    if (!glow) {
      continue;
    }
    if (count++ >= GLOWTOY.maximumActive) {
      break;
    }
    glow.charge = Math.max(
      0,
      Math.min(
        1,
        glow.charge +
          (lights.some((light) => shipIlluminates(light, rock.position))
            ? GLOWTOY.chargePerTick
            : -GLOWTOY.decayPerTick)
      )
    );
    if (glow.charge < 0.7) {
      continue;
    }
    bright.push({ ...rock.position });
    if (
      !glow.cacheRevealed &&
      Math.hypot(rock.position.x - glow.cachePosition.x, rock.position.y - glow.cachePosition.y) <=
        GLOWTOY.revealRadius
    ) {
      glow.cacheRevealed = true;
      reveal(glow.cachePosition);
    }
  }
  return bright;
}
