import { expect, test } from 'vitest';

import { Player } from '../../../src/entities/player/Player';
import { SHIP_ABILITY } from '../../../src/entities/ship/shipKits';
import { MockPlayerInput } from '../../../src/input/MockPlayerInput';
import {
  readAbilityChrome,
  readShieldChrome,
  shieldCooldownRatio,
  touchAbilityLabel,
  touchAbilityName,
} from '../../../src/input/touchAbility';
import { triggerTouchAbility, triggerTouchShield } from '../../../src/input/touchControls';

test('each kit exposes its own E action label and name', () => {
  expect(touchAbilityLabel('surveyor')).toBe('SCAN');
  expect(touchAbilityLabel('hauler')).toBe('HOOK');
  expect(touchAbilityName('hauler')).toBe('Harpoon');
  expect(touchAbilityLabel('unknown-kit')).toBe('SCAN');
});

test('E chrome distinguishes ready, cooldown, and dead', () => {
  const ready = readAbilityChrome({
    kitId: 'surveyor',
    exploding: false,
    health: 100,
    abilityCooldownFrames: 0,
    abilityActiveFrames: 0,
  });
  expect(ready.ready).toBe(true);
  expect(ready.cooling).toBe(false);
  expect(ready.unavailable).toBe(false);

  const cooling = readAbilityChrome({
    kitId: 'surveyor',
    exploding: false,
    health: 100,
    abilityCooldownFrames: SHIP_ABILITY.COOLDOWN_FRAMES.surveyor / 2,
    abilityActiveFrames: 0,
  });
  expect(cooling.ready).toBe(false);
  expect(cooling.cooling).toBe(true);
  expect(cooling.cooldownRatio).toBeCloseTo(0.5, 5);

  const dead = readAbilityChrome({
    kitId: 'surveyor',
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
  const surveyor = new Player({
    id: 'touch-surveyor',
    name: 'Touch Surveyor',
    type: 'local',
    input: new MockPlayerInput(),
    kitId: 'surveyor',
  });
  expect(triggerTouchAbility(surveyor)).toBe(true);
  expect(surveyor.ship.abilityCooldownFrames).toBeGreaterThan(0);

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
