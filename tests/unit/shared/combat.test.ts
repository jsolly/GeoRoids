import { describe, expect, test } from 'vitest';
import {
  findShipAsteroidOverlaps,
  isClientOwnedCollisionAttacker,
  isCombatantImmune,
  isWorldHazard,
  laserDamagesShips,
} from '../../../shared/combat';

describe('shared combat helpers', () => {
  test('treats exploding, dead, blinking, and protected players as immune', () => {
    expect(isCombatantImmune({ exploding: true, health: 100 })).toBe(true);
    expect(isCombatantImmune({ exploding: false, health: 0 })).toBe(true);
    expect(isCombatantImmune({ exploding: false, health: 100, blinkCount: 2 })).toBe(true);
    expect(
      isCombatantImmune({
        exploding: false,
        health: 100,
        spawnProtectionTimer: 12,
      })
    ).toBe(true);
    expect(isCombatantImmune({ exploding: false, health: 100, blinkCount: 0 })).toBe(false);
    expect(
      isCombatantImmune({
        exploding: false,
        health: 100,
        spawnProtectionTimer: 0,
      })
    ).toBe(false);
  });
  test('finds the first asteroid overlap for each ship', () => {
    const ships = [
      { id: 'a', position: { x: 0, y: 0 }, radius: 15, immune: false },
      { id: 'b', position: { x: 5, y: 0 }, radius: 15, immune: false },
      { id: 'c', position: { x: 400, y: 0 }, radius: 15, immune: false },
    ];
    const asteroids = [
      { id: 'r1', position: { x: 0, y: 0 }, radius: 25 },
      { id: 'r2', position: { x: 1, y: 0 }, radius: 25 },
    ];

    expect(findShipAsteroidOverlaps(ships, asteroids)).toEqual([
      { shipId: 'a', asteroidId: 'r1' },
      { shipId: 'b', asteroidId: 'r1' },
    ]);
  });

  test('only boundary collisions may be reported by clients', () => {
    expect(isClientOwnedCollisionAttacker('boundary')).toBe(true);
    expect(isClientOwnedCollisionAttacker('asteroid')).toBe(false);
    expect(isClientOwnedCollisionAttacker('ricochet')).toBe(false);
  });

  test('world hazards include bounced lasers but not crew pilots', () => {
    expect(isWorldHazard('asteroid')).toBe(true);
    expect(isWorldHazard('boundary')).toBe(true);
    expect(isWorldHazard('ricochet')).toBe(true);
    expect(isWorldHazard('p1')).toBe(false);
  });

  test('only bounced lasers become hull hazards', () => {
    expect(laserDamagesShips(0)).toBe(false);
    expect(laserDamagesShips(1)).toBe(true);
    expect(laserDamagesShips(8)).toBe(true);
  });
});
