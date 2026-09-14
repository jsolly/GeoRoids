import { expect, test } from 'vitest';

import { Player } from '../../../src/entities/player/Player';
import { SHIP_ABILITY } from '../../../src/entities/ship/shipKits';
import { MockPlayerInput } from '../../../src/input/MockPlayerInput';
import {
  readAbilityChrome,
  touchAbilityLabel,
  touchAbilityName,
} from '../../../src/input/touchAbility';
import { triggerTouchAbility } from '../../../src/input/touchControls';

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

test('touch E routes through the live ship action', () => {
  const surveyor = new Player({
    id: 'touch-surveyor',
    name: 'Touch Surveyor',
    type: 'local',
    input: new MockPlayerInput(),
    kitId: 'surveyor',
  });
  expect(triggerTouchAbility(surveyor)).toBe(true);
  expect(surveyor.ship.abilityCooldownFrames).toBeGreaterThan(0);
});

test('a Hauler can release cargo while the attachment cooldown is running', () => {
  const host = {
    kitId: 'hauler',
    exploding: false,
    health: 140,
    abilityCooldownFrames: SHIP_ABILITY.COOLDOWN_FRAMES.hauler - 1,
    abilityActiveFrames: 0,
    harpoonTargetId: 'cargo',
  };
  const attached = readAbilityChrome(host);
  expect(attached.ready).toBe(true);
  expect(attached.active).toBe(true);
  expect(attached.label).toBe('RELEASE');
  expect(attached.name).toBe('Release asteroid');
  expect(attached.cooldownRatio).toBe(0);
  expect(readAbilityChrome({ ...host, harpoonTargetId: null }).ready).toBe(false);
  expect(readAbilityChrome({ ...host, health: 0 }).ready).toBe(false);
});
