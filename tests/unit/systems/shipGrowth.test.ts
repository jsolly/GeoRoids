import { describe, expect, test } from 'vitest';
import {
  applyLootMass,
  canCollectLoot,
  GROWTH,
  lootOverlap,
  maxHealthFromMass,
  maxVelocityFromMass,
  planKillLoot,
  radiusFromMass,
  sizeScaleFromMass,
  thrustScaleFromMass,
} from '../../../shared/shipGrowth';
import { SHIP } from '../../../src/constants';

describe('ship growth math', () => {
  test('base mass matches the stock hull and HP', () => {
    expect(radiusFromMass(GROWTH.BASE_MASS)).toBe(SHIP.SIZE / 2);
    expect(maxHealthFromMass(GROWTH.BASE_MASS)).toBe(SHIP.MAX_HEALTH);
    expect(sizeScaleFromMass(GROWTH.BASE_MASS)).toBe(1);
    expect(thrustScaleFromMass(GROWTH.BASE_MASS)).toBe(1);
    expect(maxVelocityFromMass(GROWTH.BASE_MASS)).toBe(SHIP.MAX_VELOCITY);
  });

  test('collecting loot grows mass, size, and HP with a slither slowdown', () => {
    const grown = applyLootMass(GROWTH.BASE_MASS, 2);
    expect(grown).toBeGreaterThan(GROWTH.BASE_MASS);
    expect(radiusFromMass(grown)).toBeGreaterThan(radiusFromMass(GROWTH.BASE_MASS));
    expect(maxHealthFromMass(grown)).toBeGreaterThan(SHIP.MAX_HEALTH);
    expect(thrustScaleFromMass(grown)).toBeLessThan(1);
    expect(maxVelocityFromMass(grown)).toBeLessThan(SHIP.MAX_VELOCITY);
  });

  test('soft max keeps mass and size readable after many pickups', () => {
    let mass: number = GROWTH.BASE_MASS;
    for (let i = 0; i < 80; i++) {
      mass = applyLootMass(mass, 1);
    }
    expect(mass).toBeLessThanOrEqual(GROWTH.SOFT_MAX_MASS);
    expect(mass).toBeGreaterThan(GROWTH.SOFT_MAX_MASS - 0.2);
    expect(sizeScaleFromMass(mass)).toBeLessThanOrEqual(GROWTH.MAX_SIZE_SCALE);
    expect(thrustScaleFromMass(mass)).toBeGreaterThanOrEqual(GROWTH.MIN_THRUST_SCALE);
  });

  test('a base-mass kill still plans loot pellets', () => {
    const { pelletMasses } = planKillLoot(GROWTH.BASE_MASS);
    expect(pelletMasses.length).toBeGreaterThanOrEqual(1);
    expect(pelletMasses.reduce((sum, value) => sum + value, 0)).toBeCloseTo(GROWTH.BASE_KILL_MASS);
  });

  test('heavier ships drop more pellets than a fresh hull', () => {
    const light = planKillLoot(GROWTH.BASE_MASS).pelletMasses.length;
    const heavy = planKillLoot(GROWTH.SOFT_MAX_MASS).pelletMasses.length;
    expect(heavy).toBeGreaterThan(light);
    expect(heavy).toBeLessThanOrEqual(GROWTH.MAX_PELLETS);
  });

  test('dead and exploding ships cannot collect loot', () => {
    expect(canCollectLoot({ exploding: false, health: 100 })).toBe(true);
    expect(canCollectLoot({ exploding: true, health: 100 })).toBe(false);
    expect(canCollectLoot({ exploding: false, health: 0 })).toBe(false);
    expect(canCollectLoot({ exploding: false, health: 100, respawnTimer: 10 })).toBe(false);
  });

  test('loot overlap uses mass-scaled ship radius', () => {
    const origin = { x: 0, y: 0 };
    const nearby = { x: radiusFromMass(GROWTH.BASE_MASS) + GROWTH.LOOT_RADIUS - 1, y: 0 };
    const far = { x: radiusFromMass(GROWTH.BASE_MASS) + GROWTH.LOOT_RADIUS + 4, y: 0 };
    expect(lootOverlap(origin, GROWTH.BASE_MASS, nearby, GROWTH.LOOT_RADIUS)).toBe(true);
    expect(lootOverlap(origin, GROWTH.BASE_MASS, far, GROWTH.LOOT_RADIUS)).toBe(false);
  });
});
