import { expect, test } from 'vitest';
import {
  HAULER_UTILITY,
  haulerUtilityOf,
  isResourceTapUtility,
  isTowCableUtility,
  PREFERRED_HAULER_UTILITY,
  parseHaulerUtilityId,
  UNSET_HAULER_UTILITY,
} from '../../../src/entities/ship/haulerUtility';
import {
  type AbilityBody,
  type AbilityHost,
  activateAbilityOnHost,
  pullHarpoonTarget,
  setHaulerUtilityOnHost,
  tickTapExtract,
} from '../../../src/entities/ship/shipAbilities';
import { SHIP_ABILITY } from '../../../src/entities/ship/shipKits';

function host(kitId: AbilityHost['kitId'] = 'hauler'): AbilityHost {
  return {
    kitId,
    position: { x: 0, y: 0 },
    velocity: { x: 0, y: 0 },
    angle: 0,
    exploding: false,
    health: 100,
    abilityCooldownFrames: 0,
    abilityActiveFrames: 0,
    harpoonTargetId: null,
  };
}

test('missing Hauler utility keeps the legacy tow cable', () => {
  expect(parseHaulerUtilityId('nope')).toBe(UNSET_HAULER_UTILITY);
  expect(haulerUtilityOf(host())).toBe('tow_cable');
  expect(PREFERRED_HAULER_UTILITY).toBe('resource_tap');
  expect(HAULER_UTILITY.resource_tap.name).toBe('Resource Tap');
});

test('selecting Resource Tap then Tow Cable switches the one Hauler slot and drops a latch', () => {
  const hauler = host();
  const rock: AbilityBody = { id: 'rock', position: { x: 80, y: 0 }, velocity: { x: 0, y: 0 } };
  expect(activateAbilityOnHost(hauler, { asteroids: [rock] }).activated).toBe(true);
  expect(hauler.harpoonTargetId).toBe('rock');

  expect(setHaulerUtilityOnHost(hauler, 'resource_tap')).toBe(true);
  expect(isResourceTapUtility(hauler)).toBe(true);
  expect(hauler.harpoonTargetId).toBeNull();

  hauler.abilityCooldownFrames = 0;
  expect(activateAbilityOnHost(hauler, { asteroids: [rock] }).activated).toBe(true);
  expect(setHaulerUtilityOnHost(hauler, 'tow_cable')).toBe(true);
  expect(isTowCableUtility(hauler)).toBe(true);
  expect(hauler.harpoonTargetId).toBeNull();
});

test('Resource Tap latches without hauling the rock', () => {
  const hauler = host();
  setHaulerUtilityOnHost(hauler, 'resource_tap');
  const rock: AbilityBody = { id: 'rock', position: { x: 80, y: 0 }, velocity: { x: 0, y: 0 } };
  expect(activateAbilityOnHost(hauler, { asteroids: [rock] }).abilityId).toBe('harpoon');
  expect(hauler.harpoonTargetId).toBe('rock');

  hauler.position.x = -100;
  pullHarpoonTarget(hauler, [rock]);
  expect(rock.velocity.x).toBe(0);
  expect(hauler.harpoonTargetId).toBe('rock');
});

test('Resource Tap extract completes after the latch duration', () => {
  const hauler = host();
  setHaulerUtilityOnHost(hauler, 'resource_tap');
  const rock: AbilityBody = { id: 'rock', position: { x: 80, y: 0 }, velocity: { x: 0, y: 0 } };
  activateAbilityOnHost(hauler, { asteroids: [rock] });

  let last: ReturnType<typeof tickTapExtract> = 'idle';
  for (let i = 0; i < SHIP_ABILITY.TAP_EXTRACT_FRAMES; i++) {
    last = tickTapExtract(hauler, rock);
  }
  expect(last).toBe('complete');
  expect(hauler.tapExtractCompleted).toBe(true);
});
