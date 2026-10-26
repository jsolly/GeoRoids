import { describe, expect, test } from 'vitest';
import {
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
    expect(
      isCombatantImmune({
        exploding: false,
        health: 100,
        overlayHold: true,
      })
    ).toBe(true);
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
