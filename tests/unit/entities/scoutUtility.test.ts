import { afterEach, expect, test } from 'vitest';
import { SURVEY_PROBE } from '../../../shared/surveyProbe';
import { Player } from '../../../src/entities/player/Player';
import { Ship } from '../../../src/entities/ship/Ship';
import {
  DEFAULT_SCOUT_UTILITY,
  preferredScoutUtility,
  rememberScoutUtility,
  SCOUT_UTILITY_STORAGE_KEY,
  scoutUtilityOf,
} from '../../../src/entities/ship/scoutUtility';
import {
  type AbilityHost,
  activateAbilityOnHost,
  setScoutUtilityOnHost,
} from '../../../src/entities/ship/shipAbilities';
import {
  bindShipCombatNetwork,
  resetShipCombatNetwork,
} from '../../../src/entities/ship/shipCombatNetwork';
import { MockPlayerInput } from '../../../src/input/MockPlayerInput';
import {
  getStoredItem,
  removeStoredItem,
  resetSafeStorage,
  setStoredItem,
} from '../../../src/utils/safeStorage';

function host(kitId: AbilityHost['kitId'] = 'scout'): AbilityHost {
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

afterEach(() => {
  removeStoredItem(SCOUT_UTILITY_STORAGE_KEY);
  resetSafeStorage();
  resetShipCombatNetwork();
});

test('a new Scout starts with Mineral Scan and remembers a selected probe across reconnects', () => {
  expect(DEFAULT_SCOUT_UTILITY).toBe('mineral_scan');
  expect(preferredScoutUtility()).toBe('mineral_scan');

  rememberScoutUtility('survey_probe');
  expect(preferredScoutUtility()).toBe('survey_probe');
  expect(scoutUtilityOf({ kitId: 'scout' })).toBe('mineral_scan');
  expect(scoutUtilityOf({ kitId: 'scout', scoutUtility: 'stale' })).toBe('mineral_scan');
  expect(scoutUtilityOf({ kitId: 'hauler', scoutUtility: 'survey_probe' })).toBe('mineral_scan');
});

test('equipping Survey Probe clears a predicted scan pulse while preserving the shared cooldown', () => {
  const scout = host();
  scout.abilityActiveFrames = 12;

  expect(setScoutUtilityOnHost(scout, 'survey_probe')).toBe(true);
  expect(scout.scoutUtility).toBe('survey_probe');
  expect(scout.abilityActiveFrames).toBe(0);
  expect(setScoutUtilityOnHost(scout, 'unknown')).toBe(false);
  expect(setScoutUtilityOnHost(host('hauler'), 'survey_probe')).toBe(false);
});

test('Survey Probe activation predicts its cooldown without creating a local scan or attachment', () => {
  const scout = host();
  setScoutUtilityOnHost(scout, 'survey_probe');

  const activation = activateAbilityOnHost(scout, {
    asteroids: [{ id: 'ahead', position: { x: 100, y: 0 }, velocity: { x: 0, y: 0 } }],
  });

  expect(activation).toEqual({ activated: true, abilityId: 'surveyScan' });
  expect(scout.abilityCooldownFrames).toBe(SURVEY_PROBE.COOLDOWN_FRAMES);
  expect(scout.abilityActiveFrames).toBe(0);
  expect(scout.harpoonTargetId).toBeNull();
});

test('a connected Scout predicts probe cooldown without a local world effect', () => {
  let sent = 0;
  bindShipCombatNetwork({
    isConnected: true,
    localPlayerId: 'local',
    sendShoot: () => undefined,
    sendAbility: () => {
      sent += 1;
      return true;
    },
  });

  const ship = new Ship({ kitId: 'scout', isLocalPlayer: true });
  ship.scoutUtility = 'survey_probe';

  expect(ship.activateAbility()).toBe(true);
  expect(sent).toBe(1);
  expect(ship.abilityCooldownFrames).toBe(SURVEY_PROBE.COOLDOWN_FRAMES);
  expect(ship.abilityActiveFrames).toBe(0);
});

test('Mineral Scan keeps its existing active pulse and cooldown when selected explicitly', () => {
  const scout = host();
  setScoutUtilityOnHost(scout, 'mineral_scan');

  expect(activateAbilityOnHost(scout).activated).toBe(true);
  expect(scout.abilityActiveFrames).toBeGreaterThan(0);
  expect(scout.abilityCooldownFrames).toBeGreaterThan(SURVEY_PROBE.COOLDOWN_FRAMES);
});

test('a stale snapshot cannot replace the local probe preference while remotes follow it', () => {
  const local = new Player({
    id: 'local',
    name: 'Local',
    type: 'local',
    input: new MockPlayerInput(),
    kitId: 'scout',
  });
  local.ship.scoutUtility = 'survey_probe';
  local.updateFromServer({ kitId: 'scout', scoutUtility: 'mineral_scan' });
  expect(local.ship.scoutUtility).toBe('survey_probe');

  const remote = new Player({
    id: 'remote',
    name: 'Remote',
    type: 'remote',
    input: new MockPlayerInput(),
    kitId: 'scout',
  });
  remote.updateFromServer({ kitId: 'scout', scoutUtility: 'survey_probe' });
  expect(remote.ship.scoutUtility).toBe('survey_probe');
});

test('a returning pilot keeps their old tool choice under the Scout preference key', () => {
  setStoredItem('georoids.surveyorUtility', 'survey_probe');
  expect(preferredScoutUtility()).toBe('survey_probe');
  expect(getStoredItem(SCOUT_UTILITY_STORAGE_KEY)).toBe('survey_probe');
  expect(getStoredItem('georoids.surveyorUtility')).toBeNull();
  rememberScoutUtility('mineral_scan');
  setStoredItem('georoids.surveyorUtility', 'survey_probe');
  expect(preferredScoutUtility()).toBe('mineral_scan');
  expect(getStoredItem('georoids.surveyorUtility')).toBeNull();
});
