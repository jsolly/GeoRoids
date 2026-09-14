import { describe, expect, test } from 'vitest';
import {
  findShipAsteroidOverlaps,
  isClientOwnedCollisionAttacker,
  isCombatantImmune,
} from '../../../shared/combat';

describe('shared combat helpers', () => {
  test('treats exploding, dead, blinking, and protected humans as immune', () => {
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
  });
});
