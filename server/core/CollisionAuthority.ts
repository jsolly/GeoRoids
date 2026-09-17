import { type CombatCircle, circlesOverlap, isCombatantImmune } from '../../shared/combat';
import type { AsteroidData, SatellitePickupData } from '../../shared-types';
import { hullRadiusForKit } from '../../src/entities/ship/shipKits';
import { AsteroidSpatialIndex } from '../world/AsteroidSpatialIndex';
import type { GameEntity } from './EntityManager';

function toCombatCircle(entity: GameEntity): CombatCircle {
  return {
    id: entity.id,
    position: entity.position,
    radius: hullRadiusForKit(entity.kitId, entity.mass),
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

  public collectTowedAsteroidHits(
    towed: readonly AsteroidData[],
    asteroids: readonly AsteroidData[]
  ): Array<{ towedId: string; otherId: string }> {
    if (towed.length === 0) {
      return [];
    }
    const index = new AsteroidSpatialIndex(asteroids);
    const hits: Array<{ towedId: string; otherId: string }> = [];
    const seen = new Set<string>();
    for (const cargo of towed) {
      const radius = asteroidCollisionRadius(cargo);
      const nearby = index.query({
        minX: cargo.position.x - radius,
        minY: cargo.position.y - radius,
        maxX: cargo.position.x + radius,
        maxY: cargo.position.y + radius,
      });
      for (const other of nearby) {
        if (other.id === cargo.id || cargo.health <= 0 || other.health <= 0) {
          continue;
        }
        if (
          !circlesOverlap(cargo.position, radius, other.position, asteroidCollisionRadius(other))
        ) {
          continue;
        }
        const pairKey = cargo.id < other.id ? `${cargo.id}|${other.id}` : `${other.id}|${cargo.id}`;
        if (seen.has(pairKey)) {
          continue;
        }
        seen.add(pairKey);
        hits.push({ towedId: cargo.id, otherId: other.id });
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
