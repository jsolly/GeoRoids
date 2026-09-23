import { expect, test } from 'vitest';

import { civicLot } from '../../../shared/furnaces';
import { Player } from '../../../src/entities/player/Player';
import { SHIP_ABILITY } from '../../../src/entities/ship/shipKits';
import { MockPlayerInput } from '../../../src/input/MockPlayerInput';
import {
  readAbilityChrome,
  touchAbilityLabel,
  touchAbilityName,
} from '../../../src/input/touchAbility';
import { triggerTouchAbility } from '../../../src/input/touchControls';
import { resetWorldExploration } from '../../../src/network/worldExploration';

const furnace = civicLot('street-1-0');
if (!furnace) {
  throw new Error('Missing furnace lot');
}

test('each kit exposes its own E action label and name', () => {
  expect(touchAbilityLabel('scout')).toBe('SCAN');
  expect(touchAbilityLabel('hauler')).toBe('HOOK');
  expect(touchAbilityName('hauler')).toBe('Harpoon');
  expect(touchAbilityLabel('unknown-kit')).toBe('SCAN');
});

test('over Town Square each touch ability retains its kit tool and cooldown', () => {
  for (const kitId of ['scout', 'hauler'] as const) {
    const near = readAbilityChrome({
      kitId,
      exploding: false,
      health: 100,
      abilityCooldownFrames: 90,
      abilityActiveFrames: 0,
      position: { x: 0, y: 0 },
    });
    expect(near.label).toBe(kitId === 'scout' ? 'SCAN' : 'HOOK');
    expect(near.name).toBe(kitId === 'scout' ? 'Mineral scan' : 'Harpoon');
    expect(near.ready).toBe(false);
    expect(near.cooling).toBe(true);
    expect(near.cooldownRatio).toBeGreaterThan(0);
  }
  const far = readAbilityChrome({
    kitId: 'scout',
    exploding: false,
    health: 100,
    abilityCooldownFrames: 0,
    abilityActiveFrames: 0,
    position: { x: 20_000, y: 0 },
  });
  expect(far.label).toBe('SCAN');
});

test('near a dark furnace lot the Scout ability chrome becomes Build', () => {
  resetWorldExploration();
  const near = readAbilityChrome({
    kitId: 'scout',
    scoutUtility: 'mineral_scan',
    exploding: false,
    health: 100,
    abilityCooldownFrames: 0,
    abilityActiveFrames: 0,
    position: { ...furnace.position },
  });
  expect(near.label).toBe('BUILD');
  expect(near.name).toBe('Build furnace');
  const probing = readAbilityChrome({
    kitId: 'scout',
    scoutUtility: 'survey_probe',
    exploding: false,
    health: 100,
    abilityCooldownFrames: 0,
    abilityActiveFrames: 0,
    position: { ...furnace.position },
  });
  expect(probing.label).toBe('BUILD');
  const far = readAbilityChrome({
    kitId: 'scout',
    scoutUtility: 'mineral_scan',
    exploding: false,
    health: 100,
    abilityCooldownFrames: 0,
    abilityActiveFrames: 0,
    position: { x: 20_000, y: 20_000 },
  });
  expect(far.label).toBe('SCAN');
  expect(far.name).toBe('Mineral scan');
});

test('Survey Probe changes the mobile ability label, name, and cooldown scale', () => {
  expect(touchAbilityLabel('scout', 'survey_probe')).toBe('PROBE');
  expect(touchAbilityName('scout', 'survey_probe')).toBe('Survey probe');
  const state = readAbilityChrome({
    kitId: 'scout',
    scoutUtility: 'survey_probe',
    exploding: false,
    health: 100,
    abilityCooldownFrames: 90,
    abilityActiveFrames: 0,
  });
  expect(state.label).toBe('PROBE');
  expect(state.name).toBe('Survey probe');
  expect(state.cooldownRatio).toBeCloseTo(0.5, 5);
});

test('E chrome distinguishes ready, cooldown, and dead', () => {
  const ready = readAbilityChrome({
    kitId: 'scout',
    exploding: false,
    health: 100,
    abilityCooldownFrames: 0,
    abilityActiveFrames: 0,
  });
  expect(ready.ready).toBe(true);
  expect(ready.cooling).toBe(false);
  expect(ready.unavailable).toBe(false);

  const cooling = readAbilityChrome({
    kitId: 'scout',
    exploding: false,
    health: 100,
    abilityCooldownFrames: SHIP_ABILITY.COOLDOWN_FRAMES.scout / 2,
    abilityActiveFrames: 0,
  });
  expect(cooling.ready).toBe(false);
  expect(cooling.cooling).toBe(true);
  expect(cooling.cooldownRatio).toBeCloseTo(0.5, 5);

  const dead = readAbilityChrome({
    kitId: 'scout',
    exploding: true,
    health: 0,
    abilityCooldownFrames: 0,
    abilityActiveFrames: 0,
  });
  expect(dead.ready).toBe(false);
  expect(dead.unavailable).toBe(true);
});

test('touch E routes through the live ship action', () => {
  const scout = new Player({
    id: 'touch-scout',
    name: 'Touch Scout',
    type: 'local',
    input: new MockPlayerInput(),
    kitId: 'scout',
  });
  expect(triggerTouchAbility(scout)).toBe(true);
  expect(scout.ship.abilityCooldownFrames).toBeGreaterThan(0);
});

test('Hauler ready chrome follows the equipped utility', () => {
  const host = {
    kitId: 'hauler' as const,
    exploding: false,
    health: 140,
    abilityCooldownFrames: 0,
    abilityActiveFrames: 0,
    harpoonTargetId: null,
  };
  expect(readAbilityChrome(host).label).toBe('HOOK');
  expect(readAbilityChrome({ ...host, haulerUtility: 'tow_cable' }).label).toBe('HOOK');
  expect(readAbilityChrome({ ...host, haulerUtility: 'resource_tap' }).label).toBe('TAP');
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

test('a Scout can build an escape furnace while its scan or probe is cooling down', () => {
  resetWorldExploration();
  for (const scoutUtility of ['mineral_scan', 'survey_probe'] as const) {
    const chrome = readAbilityChrome({
      kitId: 'scout',
      scoutUtility,
      exploding: false,
      health: 100,
      abilityCooldownFrames: 120,
      abilityActiveFrames: 60,
      position: furnace.position,
    });
    expect(chrome.label).toBe('BUILD');
    expect(chrome.ready).toBe(true);
    expect(chrome.cooling).toBe(false);
    expect(chrome.cooldownRatio).toBe(0);
  }
});
