import type { AsteroidData, SatelliteData } from '../../shared-types';
import {
  findShipAsteroidOverlaps,
  findShipShipPairs,
  isCombatantImmune,
  shipShipPairKey,
  shouldApplyShipShipTick,
  type CombatCircle,
} from '../../shared/combat';
import { GROWTH, radiusFromMass } from '../../shared/shipGrowth';
import type { GameEntity } from './EntityManager';

export function toCombatCircle(entity: GameEntity): CombatCircle {
  return {
    id: entity.id,
    position: entity.position,
    radius: radiusFromMass(entity.mass ?? GROWTH.BASE_MASS),
    immune: isCombatantImmune(entity),
  };
}

export function asteroidCollisionRadius(asteroid: AsteroidData): number {
  return asteroid.size;
}

export class CollisionAuthority {
  private shipShipLastTick = new Map<string, number>();

  public reset(): void {
    this.shipShipLastTick.clear();
  }

  public collectShipAsteroidHits(
    entities: GameEntity[],
    asteroids: AsteroidData[]
  ): Array<{ shipId: string; asteroidId: string }> {
    return findShipAsteroidOverlaps(
      entities.map(toCombatCircle),
      asteroids.map((asteroid) => ({
        id: asteroid.id,
        position: asteroid.position,
        radius: asteroidCollisionRadius(asteroid),
      }))
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
