import { type CombatCircle, circlesOverlap, isCombatantImmune } from '../../shared/combat';
import { GROWTH, radiusFromMass } from '../../shared/shipGrowth';
import type { AsteroidData, SatellitePickupData } from '../../shared-types';
import { AsteroidSpatialIndex } from '../world/AsteroidSpatialIndex';
import type { GameEntity } from './EntityManager';

function toCombatCircle(entity: GameEntity): CombatCircle {
  return {
    id: entity.id,
    position: entity.position,
    radius: radiusFromMass(entity.mass ?? GROWTH.BASE_MASS),
    immune: isCombatantImmune(entity),
  };
}

function asteroidCollisionRadius(asteroid: AsteroidData): number {
  return asteroid.size;
}

export class CollisionAuthority {
  public collectShipAsteroidHits(
    entities: GameEntity[],
    asteroids: AsteroidData[],
    shouldSkip?: (shipId: string, asteroidId: string) => boolean
  ): Array<{ shipId: string; asteroidId: string }> {
    const index = new AsteroidSpatialIndex(asteroids);
    const hits: Array<{ shipId: string; asteroidId: string }> = [];
    for (const entity of entities) {
      const ship = toCombatCircle(entity);
      if (ship.immune) {
        continue;
      }
      const nearby = index.query({
        minX: ship.position.x - ship.radius,
        minY: ship.position.y - ship.radius,
        maxX: ship.position.x + ship.radius,
        maxY: ship.position.y + ship.radius,
      });
      const rock = nearby.find(
        (candidate) =>
          !shouldSkip?.(ship.id, candidate.id) &&
          circlesOverlap(ship.position, ship.radius, candidate.position, candidate.size)
      );
      if (rock) {
        hits.push({ shipId: ship.id, asteroidId: rock.id });
      }
    }
    return hits;
  }

  public collectAsteroidPickupHits(
    asteroids: AsteroidData[],
    pickups: SatellitePickupData[]
  ): Array<{ asteroidId: string; pickupId: string }> {
    const livePickups = pickups.filter((pickup) => pickup.state !== 'broken' && pickup.health > 0);
    const hits: Array<{ asteroidId: string; pickupId: string }> = [];
    for (const pickup of livePickups) {
      const asteroid = asteroids.find((candidate) =>
        circlesOverlap(
          pickup.position,
          pickup.radius,
          candidate.position,
          asteroidCollisionRadius(candidate)
        )
      );
      if (asteroid) {
        hits.push({ asteroidId: asteroid.id, pickupId: pickup.id });
      }
    }
    return hits;
  }
}
