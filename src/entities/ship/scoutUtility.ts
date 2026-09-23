import { SURVEY_PROBE } from '../../../shared/surveyProbe';
import type { ScoutUtilityId, ShipKitId } from '../../../shared-types';
import { getStoredItem, removeStoredItem, setStoredItem } from '../../utils/safeStorage';

export const SCOUT_UTILITY_IDS = ['mineral_scan', 'survey_probe'] as const;

export const DEFAULT_SCOUT_UTILITY: ScoutUtilityId = 'mineral_scan';
export const SCOUT_UTILITY_STORAGE_KEY = 'georoids.scoutUtility';

export const SCOUT_UTILITY = {
  mineral_scan: {
    id: 'mineral_scan',
    name: 'Mineral Scan',
    hint: 'Tap to equip',
    copy: 'Scan minerals for the crew and scare nearby spiders away while active. Earn points when a Hauler delivers scanned rocks.',
  },
  survey_probe: {
    id: 'survey_probe',
    name: 'Survey Probe',
    hint: `Tap to equip · ${SURVEY_PROBE.MAX_PER_OWNER} max`,
    copy: `Fire a beacon forward. It scans a ${SURVEY_PROBE.RANGE}-unit radius for ${SURVEY_PROBE.LIFETIME_MS / 60_000} minutes, with ${SURVEY_PROBE.MAX_HEALTH} health. Everyone benefits.`,
  },
} as const;

export function isScoutUtilityId(value: unknown): value is ScoutUtilityId {
  return value === 'mineral_scan' || value === 'survey_probe';
}

function parseScoutUtilityId(value: unknown): ScoutUtilityId {
  return isScoutUtilityId(value) ? value : DEFAULT_SCOUT_UTILITY;
}

export function scoutUtilityOf(host: {
  kitId?: ShipKitId | string;
  scoutUtility?: unknown;
}): ScoutUtilityId {
  if (host.kitId !== 'scout') {
    return DEFAULT_SCOUT_UTILITY;
  }
  return isScoutUtilityId(host.scoutUtility) ? host.scoutUtility : DEFAULT_SCOUT_UTILITY;
}

export function preferredScoutUtility(): ScoutUtilityId {
  let stored = getStoredItem(SCOUT_UTILITY_STORAGE_KEY);
  const retiredKey = 'georoids.surveyorUtility';
  const retired = getStoredItem(retiredKey);
  if (stored === null && isScoutUtilityId(retired)) {
    stored = retired;
    setStoredItem(SCOUT_UTILITY_STORAGE_KEY, retired);
  }
  removeStoredItem(retiredKey);
  return stored === null ? DEFAULT_SCOUT_UTILITY : parseScoutUtilityId(stored);
}

export function rememberScoutUtility(utilityId: ScoutUtilityId): void {
  setStoredItem(SCOUT_UTILITY_STORAGE_KEY, utilityId);
}
