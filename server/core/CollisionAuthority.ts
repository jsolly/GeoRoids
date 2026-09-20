import { type CombatCircle, circlesOverlap, isCombatantImmune } from '../../shared/combat';
import type { AsteroidData, Position, SatellitePickupData, Velocity } from '../../shared-types';
import { hullRadiusForKit } from '../../src/entities/ship/shipKits';
import { AsteroidSpatialIndex } from '../world/AsteroidSpatialIndex';
import type { GameEntity } from './EntityManager';

function toCombatCircle(entity: GameEntity): CombatCircle {
  return {
    id: entity.id,
    position: entity.position,
    radius: hullRadiusForKit(entity.kitId),
    immune: isCombatantImmune(entity),
  };
}

function asteroidCollisionRadius(asteroid: AsteroidData): number {
  return asteroid.size;
}

/** Push a ship out of a surviving rock so the next frame is not another ram. */
export function separateShipFromAsteroid(
  ship: { position: Position; velocity: Velocity },
  shipRadius: number,
  rock: { position: Position; size: number }
): void {
  const dx = ship.position.x - rock.position.x;
  const dy = ship.position.y - rock.position.y;
  const distance = Math.hypot(dx, dy);
  const minDistance = shipRadius + rock.size + 0.5;
  if (distance >= minDistance) {
    return;
  }
  const nx = distance > 1e-6 ? dx / distance : 1;
  const ny = distance > 1e-6 ? dy / distance : 0;
  const push = minDistance - distance;
  ship.position.x += nx * push;
  ship.position.y += ny * push;
  const radial = ship.velocity.x * nx + ship.velocity.y * ny;
  if (radial < 0) {
    ship.velocity.x -= nx * radial;
    ship.velocity.y -= ny * radial;
  }
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
    const livePickups = pickups.filter(
      (pickup) => pickup.state === 'orbiting' && pickup.health > 0
    );
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
