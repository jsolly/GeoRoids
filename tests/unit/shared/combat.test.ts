import { describe, expect, test } from 'vitest';
import {
  asteroidRamDamage,
  clampLaserDamage,
  findShipAsteroidOverlaps,
  findShipShipPairs,
  isAllowedLaserReporter,
  isClientOwnedCollisionAttacker,
  isCombatantImmune,
  isServerOwnedRamAttacker,
  shipShipTickDamage,
  shouldApplyShipShipTick,
} from '../../../shared/combat';
import { DAMAGE } from '../../../src/constants';

describe('shared combat helpers', () => {
  test('treats exploding, dead, blinking, and protected humans as immune', () => {
    expect(isCombatantImmune({ exploding: true, health: 100 })).toBe(true);
    expect(isCombatantImmune({ exploding: false, health: 0 })).toBe(true);
    expect(isCombatantImmune({ exploding: false, health: 100, blinkCount: 2 })).toBe(true);
    expect(
      isCombatantImmune({
        exploding: false,
        health: 100,
        type: 'human',
        spawnProtectionTimer: 12,
      })
    ).toBe(true);
    expect(isCombatantImmune({ exploding: false, health: 100, blinkCount: 0 })).toBe(false);
  });

  test('bot spawn protection follows the shared debug flag', () => {
    expect(
      isCombatantImmune({
        exploding: false,
        health: 100,
        type: 'bot',
        spawnProtectionTimer: 12,
      })
    ).toBe(false);
  });

  test('finds one asteroid overlap per ship and unique ship pairs', () => {
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
    expect(findShipShipPairs(ships)).toEqual([{ a: 'a', b: 'b' }]);
  });

  test('laser reporter and ram-attacker gates match the authority split', () => {
    expect(isAllowedLaserReporter('a', 'a', 'b')).toBe(true);
    expect(isAllowedLaserReporter('b', 'a', 'b')).toBe(true);
    expect(isAllowedLaserReporter('c', 'a', 'b')).toBe(false);
    expect(isClientOwnedCollisionAttacker('boundary')).toBe(true);
    expect(isClientOwnedCollisionAttacker('asteroid')).toBe(false);
    expect(isServerOwnedRamAttacker('asteroid')).toBe(true);
    expect(isServerOwnedRamAttacker('asteroid-collision')).toBe(true);
    expect(isServerOwnedRamAttacker('server-sat-0')).toBe(true);
    expect(isServerOwnedRamAttacker('player-1')).toBe(false);
  });

  test('clamps laser damage and uses the shared tick values', () => {
    expect(clampLaserDamage(1000)).toBe(DAMAGE.LASER_HIT);
    expect(clampLaserDamage(0)).toBe(0);
    expect(asteroidRamDamage()).toBe(DAMAGE.LASER_HIT);
    expect(shipShipTickDamage()).toBe(1);
    expect(shouldApplyShipShipTick(undefined, 1000)).toBe(true);
    expect(shouldApplyShipShipTick(1000, 1049)).toBe(false);
    expect(shouldApplyShipShipTick(1000, 1050)).toBe(true);
  });
});
