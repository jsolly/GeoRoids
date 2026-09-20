import { isColossalAsteroid } from '../../shared/asteroidScale';
import type { AsteroidData, LootData, Position, SatellitePickupData } from '../../shared-types';

export interface SpiderResource {
  id: string;
  position: Position;
  value: 0 | 1 | 2;
}

/** Only stationary deposits can anchor a territory; carried resources never do. */
export function spiderResources(
  asteroids: readonly AsteroidData[],
  loot: readonly LootData[],
  pickups: readonly SatellitePickupData[]
): SpiderResource[] {
  const resources: SpiderResource[] = [];
  for (const rock of asteroids) {
    if (rock.health <= 0 || rock.velocity.x !== 0 || rock.velocity.y !== 0) {
      continue;
    }
    resources.push({
      id: rock.id,
      position: rock.position,
      value: isColossalAsteroid(rock.size)
        ? 2
        : rock.phenomenon?.kind === 'reflective' || rock.material === 'metal'
          ? 1
          : 0,
    });
  }
  for (const drop of loot) {
    resources.push({
      id: drop.id,
      position: drop.position,
      value: drop.kind === 'laserCore' ? 2 : drop.mass >= 0.75 ? 1 : 0,
    });
  }
  for (const pickup of pickups) {
    if (pickup.state === 'loose' && pickup.health > 0) {
      resources.push({ id: pickup.id, position: pickup.position, value: 1 });
    }
  }
  return resources;
}
