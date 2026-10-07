import { describe, expect, test } from 'vitest';
import {
  addLootMagnetPull,
  canCollectLoot,
  GROWTH,
  lootOverlap,
  maxHealthFromMass,
  maxVelocityFromMass,
  thrustScaleFromMass,
} from '../../../shared/shipGrowth';
import { SHIP } from '../../../src/constants';
import { hullRadiusForKit } from '../../../src/entities/ship/shipKits';

describe('saved ship mass and salvage rules', () => {
  test('base mass matches the stock HP and handling', () => {
    expect(maxHealthFromMass(GROWTH.BASE_MASS)).toBe(SHIP.MAX_HEALTH);
    expect(thrustScaleFromMass(GROWTH.BASE_MASS)).toBe(1);
    expect(maxVelocityFromMass(GROWTH.BASE_MASS)).toBe(SHIP.MAX_VELOCITY);
    expect(hullRadiusForKit('scout')).toBe(SHIP.SIZE / 2);
  });

  test('dead and exploding ships cannot collect loot', () => {
    expect(canCollectLoot({ exploding: false, health: 100 })).toBe(true);
    expect(canCollectLoot({ exploding: true, health: 100 })).toBe(false);
    expect(canCollectLoot({ exploding: false, health: 0 })).toBe(false);
    expect(canCollectLoot({ exploding: false, health: 100, respawnTimer: 10 })).toBe(false);
  });

  test('a held overlay cannot collect loot', () => {
    expect(canCollectLoot({ exploding: false, health: 100, overlayHold: true })).toBe(false);
  });

  test('loot overlap uses the kit hull radius', () => {
    const origin = { x: 0, y: 0 };
    const scoutRadius = hullRadiusForKit('scout');
    const nearby = { x: scoutRadius + GROWTH.LOOT_RADIUS - 1, y: 0 };
    const far = { x: scoutRadius + GROWTH.LOOT_RADIUS + 4, y: 0 };
    expect(lootOverlap(origin, scoutRadius, nearby, GROWTH.LOOT_RADIUS)).toBe(true);
    expect(lootOverlap(origin, scoutRadius, far, GROWTH.LOOT_RADIUS)).toBe(false);
  });

  test('a larger kit hull reaches loot that a Scout hull still misses', () => {
    const origin = { x: 0, y: 0 };
    const justPastScout = {
      x: hullRadiusForKit('scout') + GROWTH.LOOT_RADIUS + 4,
      y: 0,
    };
    expect(lootOverlap(origin, hullRadiusForKit('scout'), justPastScout, GROWTH.LOOT_RADIUS)).toBe(
      false
    );
    expect(lootOverlap(origin, hullRadiusForKit('hauler'), justPastScout, GROWTH.LOOT_RADIUS)).toBe(
      true
    );
  });

  test('loot magnet adds pull toward the nearest ship without replacing velocity', () => {
    const drop = { position: { x: 80, y: 0 }, velocity: { x: 4, y: 1 } };
    expect(
      addLootMagnetPull(drop, [{ x: drop.position.x + GROWTH.LOOT_MAGNET_RANGE + 10, y: 0 }])
    ).toBe(false);
    expect(drop.velocity).toEqual({ x: 4, y: 1 });

    expect(addLootMagnetPull(drop, [{ x: 0, y: 0 }])).toBe(true);
    expect(drop.velocity.x).toBeCloseTo(4 - GROWTH.LOOT_MAGNET_ACCEL);
    expect(drop.velocity.y).toBeCloseTo(1);
  });
});
