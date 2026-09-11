import {
  type CombatCircle,
  circlesOverlap,
  findShipAsteroidOverlaps,
  findShipShipPairs,
  isCombatantImmune,
  shipShipPairKey,
  shouldApplyShipShipTick,
} from '../../shared/combat';
import { GROWTH, radiusFromMass } from '../../shared/shipGrowth';
import type { AsteroidData, SatelliteData, SatellitePickupData } from '../../shared-types';
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
  private shipShipLastTick = new Map<string, number>();

  public reset(): void {
    this.shipShipLastTick.clear();
  }

  public collectShipAsteroidHits(
    entities: GameEntity[],
    asteroids: AsteroidData[],
    shouldSkip?: (shipId: string, asteroidId: string) => boolean
  ): Array<{ shipId: string; asteroidId: string }> {
    return findShipAsteroidOverlaps(
      entities.map(toCombatCircle),
      asteroids.map((asteroid) => ({
        id: asteroid.id,
        position: asteroid.position,
        radius: asteroidCollisionRadius(asteroid),
      })),
      shouldSkip
    );
  }

  public collectShipSatelliteHits(
    entities: GameEntity[],
    satellites: SatelliteData[]
  ): Array<{ shipId: string; satelliteId: string }> {
    const living = satellites.filter((satellite) => !satellite.exploding && satellite.health > 0);
    return findShipAsteroidOverlaps(
      entities.map(toCombatCircle),
      living.map((satellite) => ({
        id: satellite.id,
        position: satellite.position,
        radius: satellite.radius,
      }))
    ).map((hit) => ({ shipId: hit.shipId, satelliteId: hit.asteroidId }));
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

  public collectShipShipTicks(
    entities: GameEntity[],
    now: number
  ): Array<{ a: string; b: string }> {
    const pairs = findShipShipPairs(entities.map(toCombatCircle));
    const due: Array<{ a: string; b: string }> = [];
    for (const pair of pairs) {
      const key = shipShipPairKey(pair.a, pair.b);
      if (shouldApplyShipShipTick(this.shipShipLastTick.get(key), now)) {
        this.shipShipLastTick.set(key, now);
        due.push(pair);
      }
    }
    return due;
  }
}
