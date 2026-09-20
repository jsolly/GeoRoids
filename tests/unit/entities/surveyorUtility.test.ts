import { afterEach, expect, test } from 'vitest';
import { SURVEY_PROBE } from '../../../shared/surveyProbe';
import { Player } from '../../../src/entities/player/Player';
import { Ship } from '../../../src/entities/ship/Ship';
import {
  type AbilityHost,
  activateAbilityOnHost,
  setSurveyorUtilityOnHost,
} from '../../../src/entities/ship/shipAbilities';
import {
  bindShipCombatNetwork,
  resetShipCombatNetwork,
} from '../../../src/entities/ship/shipCombatNetwork';
import {
  DEFAULT_SURVEYOR_UTILITY,
  preferredSurveyorUtility,
  rememberSurveyorUtility,
  SURVEYOR_UTILITY_STORAGE_KEY,
  surveyorUtilityOf,
} from '../../../src/entities/ship/surveyorUtility';
import { MockPlayerInput } from '../../../src/input/MockPlayerInput';
import { removeStoredItem, resetSafeStorage } from '../../../src/utils/safeStorage';

function host(kitId: AbilityHost['kitId'] = 'surveyor'): AbilityHost {
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
  removeStoredItem(SURVEYOR_UTILITY_STORAGE_KEY);
  resetSafeStorage();
  resetShipCombatNetwork();
});

test('a new Surveyor starts with Mineral Scan and remembers a selected probe across reconnects', () => {
  expect(DEFAULT_SURVEYOR_UTILITY).toBe('mineral_scan');
  expect(preferredSurveyorUtility()).toBe('mineral_scan');

  rememberSurveyorUtility('survey_probe');
  expect(preferredSurveyorUtility()).toBe('survey_probe');
  expect(surveyorUtilityOf({ kitId: 'surveyor' })).toBe('mineral_scan');
  expect(surveyorUtilityOf({ kitId: 'surveyor', surveyorUtility: 'stale' })).toBe('mineral_scan');
  expect(surveyorUtilityOf({ kitId: 'hauler', surveyorUtility: 'survey_probe' })).toBe(
    'mineral_scan'
  );
});

test('equipping Survey Probe clears a predicted scan pulse while preserving the shared cooldown', () => {
  const surveyor = host();
  surveyor.abilityActiveFrames = 12;

  expect(setSurveyorUtilityOnHost(surveyor, 'survey_probe')).toBe(true);
  expect(surveyor.surveyorUtility).toBe('survey_probe');
  expect(surveyor.abilityActiveFrames).toBe(0);
  expect(setSurveyorUtilityOnHost(surveyor, 'unknown')).toBe(false);
  expect(setSurveyorUtilityOnHost(host('hauler'), 'survey_probe')).toBe(false);
});

test('Survey Probe activation predicts its cooldown without creating a local scan or attachment', () => {
  const surveyor = host();
  setSurveyorUtilityOnHost(surveyor, 'survey_probe');

  const activation = activateAbilityOnHost(surveyor, {
    asteroids: [{ id: 'ahead', position: { x: 100, y: 0 }, velocity: { x: 0, y: 0 } }],
  });

  expect(activation).toEqual({ activated: true, abilityId: 'surveyScan' });
  expect(surveyor.abilityCooldownFrames).toBe(SURVEY_PROBE.COOLDOWN_FRAMES);
  expect(surveyor.abilityActiveFrames).toBe(0);
  expect(surveyor.harpoonTargetId).toBeNull();
});

test('a connected Surveyor predicts probe cooldown without a local world effect', () => {
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

  const ship = new Ship({ kitId: 'surveyor', isLocalPlayer: true });
  ship.surveyorUtility = 'survey_probe';

  expect(ship.activateAbility()).toBe(true);
  expect(sent).toBe(1);
  expect(ship.abilityCooldownFrames).toBe(SURVEY_PROBE.COOLDOWN_FRAMES);
  expect(ship.abilityActiveFrames).toBe(0);
});

test('Mineral Scan keeps its existing active pulse and cooldown when selected explicitly', () => {
  const surveyor = host();
  setSurveyorUtilityOnHost(surveyor, 'mineral_scan');

  expect(activateAbilityOnHost(surveyor).activated).toBe(true);
  expect(surveyor.abilityActiveFrames).toBeGreaterThan(0);
  expect(surveyor.abilityCooldownFrames).toBeGreaterThan(SURVEY_PROBE.COOLDOWN_FRAMES);
});

test('a stale snapshot cannot replace the local probe preference while remotes follow it', () => {
  const local = new Player({
    id: 'local',
    name: 'Local',
    type: 'local',
    input: new MockPlayerInput(),
    kitId: 'surveyor',
  });
  local.ship.surveyorUtility = 'survey_probe';
  local.updateFromServer({ kitId: 'surveyor', surveyorUtility: 'mineral_scan' });
  expect(local.ship.surveyorUtility).toBe('survey_probe');

  const remote = new Player({
    id: 'remote',
    name: 'Remote',
    type: 'remote',
    input: new MockPlayerInput(),
    kitId: 'surveyor',
  });
  remote.updateFromServer({ kitId: 'surveyor', surveyorUtility: 'survey_probe' });
  expect(remote.ship.surveyorUtility).toBe('survey_probe');
});
