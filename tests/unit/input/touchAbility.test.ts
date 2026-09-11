import { expect, test } from 'vitest';

import { FUEL } from '../../../src/constants';
import { Player } from '../../../src/entities/player/Player';
import { SHIP_ABILITY } from '../../../src/entities/ship/shipKits';
import { MockPlayerInput } from '../../../src/input/MockPlayerInput';
import {
  abilityCooldownRatio,
  canAffordTouchAbility,
  readAbilityChrome,
  readShieldChrome,
  shieldCooldownRatio,
  touchAbilityLabel,
  touchAbilityName,
} from '../../../src/input/touchAbility';
import { triggerTouchAbility, triggerTouchShield } from '../../../src/input/touchControls';

test('each kit exposes its own E action label and name', () => {
  expect(touchAbilityLabel('dart')).toBe('DASH');
  expect(touchAbilityLabel('hauler')).toBe('HOOK');
  expect(touchAbilityLabel('warden')).toBe('GUARD');
  expect(touchAbilityLabel('skirmisher')).toBe('BURST');
  expect(touchAbilityLabel('quake')).toBe('PULSE');
  expect(touchAbilityName('hauler')).toBe('Harpoon');
  expect(touchAbilityName('warden')).toBe('Projected ally shield');
  expect(touchAbilityLabel('unknown-kit')).toBe('DASH');
});

test('E chrome distinguishes ready, cooldown, dead, and empty Quake fuel', () => {
  const ready = readAbilityChrome({
    kitId: 'dart',
    exploding: false,
    health: 100,
    abilityCooldownFrames: 0,
    abilityActiveFrames: 0,
  });
  expect(ready.ready).toBe(true);
  expect(ready.cooling).toBe(false);
  expect(ready.unavailable).toBe(false);

  const cooling = readAbilityChrome({
    kitId: 'dart',
    exploding: false,
    health: 100,
    abilityCooldownFrames: SHIP_ABILITY.COOLDOWN_FRAMES.dart / 2,
    abilityActiveFrames: 0,
  });
  expect(cooling.ready).toBe(false);
  expect(cooling.cooling).toBe(true);
  expect(cooling.cooldownRatio).toBeCloseTo(0.5, 5);

  const empty = readAbilityChrome({
    kitId: 'quake',
    exploding: false,
    health: 100,
    abilityCooldownFrames: 0,
    abilityActiveFrames: 0,
    fuel: FUEL.EMP_COST - 1,
  });
  expect(empty.ready).toBe(false);
  expect(empty.unavailable).toBe(true);
  expect(empty.cooling).toBe(false);

  const dead = readAbilityChrome({
    kitId: 'dart',
    exploding: true,
    health: 0,
    abilityCooldownFrames: 0,
    abilityActiveFrames: 0,
  });
  expect(dead.ready).toBe(false);
  expect(dead.unavailable).toBe(true);
});

test('F chrome stays independently toggleable and reports its cooldown', () => {
  const initial = readShieldChrome({
    shieldActive: false,
    shieldTime: 0,
    shieldCooldown: 0,
    shieldFlashTime: 0,
    exploding: false,
    health: 100,
  });
  expect(initial.ready).toBe(true);
  expect(initial.active).toBe(false);

  const active = readShieldChrome({
    shieldActive: true,
    shieldTime: 30,
    shieldCooldown: 0,
    shieldFlashTime: 0,
    exploding: false,
    health: 100,
  });
  expect(active.ready).toBe(true);
  expect(active.active).toBe(true);

  const cooling = readShieldChrome({
    shieldActive: false,
    shieldTime: 0,
    shieldCooldown: 30,
    shieldFlashTime: 0,
    exploding: false,
    health: 100,
  });
  expect(cooling.ready).toBe(false);
  expect(cooling.cooling).toBe(true);
  expect(cooling.cooldownRatio).toBeCloseTo(30 / 360, 5);
  expect(shieldCooldownRatio(0)).toBe(0);
});

test('touch E and F route through the live ship actions', () => {
  const dart = new Player({
    id: 'touch-dart',
    name: 'Touch Dart',
    type: 'local',
    input: new MockPlayerInput(),
    kitId: 'dart',
  });
  expect(triggerTouchAbility(dart)).toBe(true);
  expect(dart.ship.abilityCooldownFrames).toBeGreaterThan(0);

  const shield = new Player({
    id: 'touch-shield',
    name: 'Touch Shield',
    type: 'local',
    input: new MockPlayerInput(),
  });
  expect(triggerTouchShield(shield)).toBe(true);
  expect(shield.ship.shieldActive).toBe(true);
  expect(triggerTouchShield(shield)).toBe(true);
  expect(shield.ship.shieldActive).toBe(false);
});

test('Quake E readiness follows the same fuel floor as activation', () => {
  expect(
    canAffordTouchAbility({
      kitId: 'quake',
      exploding: false,
      health: 100,
      abilityCooldownFrames: 0,
      abilityActiveFrames: 0,
      fuel: FUEL.EMP_COST,
    })
  ).toBe(true);
  expect(abilityCooldownRatio('warden', 0)).toBe(0);
});
