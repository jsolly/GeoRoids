import { describe, expect, test } from 'vitest';
import {
  addLootMagnetPull,
  applyLootMass,
  canCollectLoot,
  GROWTH,
  lootOverlap,
  maxHealthFromMass,
  maxVelocityFromMass,
  planKillLoot,
  thrustScaleFromMass,
} from '../../../shared/shipGrowth';
import { SHIP } from '../../../src/constants';
import { hullRadiusForKit } from '../../../src/entities/ship/shipKits';

describe('ship growth math', () => {
  test('base mass matches the stock HP and handling', () => {
    expect(maxHealthFromMass(GROWTH.BASE_MASS)).toBe(SHIP.MAX_HEALTH);
    expect(thrustScaleFromMass(GROWTH.BASE_MASS)).toBe(1);
    expect(maxVelocityFromMass(GROWTH.BASE_MASS)).toBe(SHIP.MAX_VELOCITY);
    expect(hullRadiusForKit('surveyor')).toBe(SHIP.SIZE / 2);
  });

  test('collecting loot grows mass and HP with a slither slowdown, not hull size', () => {
    const grown = applyLootMass(GROWTH.BASE_MASS, 2);
    expect(grown).toBeGreaterThan(GROWTH.BASE_MASS);
    expect(maxHealthFromMass(grown)).toBeGreaterThan(SHIP.MAX_HEALTH);
    expect(thrustScaleFromMass(grown)).toBeLessThan(1);
    expect(maxVelocityFromMass(grown)).toBeLessThan(SHIP.MAX_VELOCITY);
    expect(hullRadiusForKit('surveyor')).toBe(SHIP.SIZE / 2);
    expect(hullRadiusForKit('hauler')).toBe(SHIP.SIZE);
  });

  test('soft max keeps mass readable after many pickups without changing kit radius', () => {
    let mass: number = GROWTH.BASE_MASS;
    for (let i = 0; i < 80; i++) {
      mass = applyLootMass(mass, 1);
    }
    expect(mass).toBeLessThanOrEqual(GROWTH.SOFT_MAX_MASS);
    expect(mass).toBeGreaterThan(GROWTH.SOFT_MAX_MASS - 0.2);
    expect(maxHealthFromMass(mass)).toBe(Math.round(SHIP.MAX_HEALTH * GROWTH.MAX_HEALTH_SCALE));
    expect(thrustScaleFromMass(mass)).toBeGreaterThanOrEqual(GROWTH.MIN_THRUST_SCALE);
    expect(hullRadiusForKit('surveyor')).toBe(SHIP.SIZE / 2);
    expect(hullRadiusForKit('hauler')).toBe(SHIP.SIZE);
  });

  test('a base-mass kill still plans loot pellets', () => {
    const { pelletMasses } = planKillLoot(GROWTH.BASE_MASS);
    expect(pelletMasses.length).toBeGreaterThanOrEqual(1);
    expect(pelletMasses.reduce((sum, value) => value + sum, 0)).toBeCloseTo(GROWTH.BASE_KILL_MASS);
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

  test('a held overlay cannot collect loot', () => {
    expect(canCollectLoot({ exploding: false, health: 100, overlayHold: true })).toBe(false);
  });

  test('loot overlap uses the kit hull radius', () => {
    const origin = { x: 0, y: 0 };
    const surveyorRadius = hullRadiusForKit('surveyor');
    const nearby = { x: surveyorRadius + GROWTH.LOOT_RADIUS - 1, y: 0 };
    const far = { x: surveyorRadius + GROWTH.LOOT_RADIUS + 4, y: 0 };
    expect(lootOverlap(origin, surveyorRadius, nearby, GROWTH.LOOT_RADIUS)).toBe(true);
    expect(lootOverlap(origin, surveyorRadius, far, GROWTH.LOOT_RADIUS)).toBe(false);
  });

  test('a larger kit hull reaches loot that a Surveyor hull still misses', () => {
    const origin = { x: 0, y: 0 };
    const justPastSurveyor = {
      x: hullRadiusForKit('surveyor') + GROWTH.LOOT_RADIUS + 4,
      y: 0,
    };
    expect(
      lootOverlap(origin, hullRadiusForKit('surveyor'), justPastSurveyor, GROWTH.LOOT_RADIUS)
    ).toBe(false);
    expect(
      lootOverlap(origin, hullRadiusForKit('hauler'), justPastSurveyor, GROWTH.LOOT_RADIUS)
    ).toBe(true);
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
