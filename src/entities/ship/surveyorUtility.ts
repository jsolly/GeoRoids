import { SURVEY_PROBE } from '../../../shared/surveyProbe';
import type { ShipKitId, SurveyorUtilityId } from '../../../shared-types';
import { getStoredItem, setStoredItem } from '../../utils/safeStorage';

export const SURVEYOR_UTILITY_IDS = ['mineral_scan', 'survey_probe', 'build_furnace'] as const;

export const DEFAULT_SURVEYOR_UTILITY: SurveyorUtilityId = 'mineral_scan';
export const SURVEYOR_UTILITY_STORAGE_KEY = 'georoids.surveyorUtility';

export const SURVEYOR_UTILITY = {
  mineral_scan: {
    id: 'mineral_scan',
    name: 'Mineral Scan',
    hint: 'Tap to equip',
    copy: 'Scan minerals for the crew and scare nearby spiders away while active. Earn points when a Hauler delivers scanned rocks.',
  },
  build_furnace: {
    id: 'build_furnace',
    name: 'Build',
    hint: 'Tap to equip · build sites',
    copy: 'Stand inside a dark street foundation and spend your own score to build that furnace. It keeps your name. The inward lot on that road must already be burning. Built furnaces survive death, reconnects, and restarts until the world resets.',
  },
  survey_probe: {
    id: 'survey_probe',
    name: 'Survey Probe',
    hint: `Tap to equip · ${SURVEY_PROBE.MAX_PER_OWNER} max`,
    copy: `Fire a beacon forward. It scans a ${SURVEY_PROBE.RANGE}-unit radius for ${SURVEY_PROBE.LIFETIME_MS / 60_000} minutes, with ${SURVEY_PROBE.MAX_HEALTH} health. Everyone benefits.`,
  },
} as const;

export function isSurveyorUtilityId(value: unknown): value is SurveyorUtilityId {
  return value === 'mineral_scan' || value === 'survey_probe' || value === 'build_furnace';
}

function parseSurveyorUtilityId(value: unknown): SurveyorUtilityId {
  return isSurveyorUtilityId(value) ? value : DEFAULT_SURVEYOR_UTILITY;
}

export function surveyorUtilityOf(host: {
  kitId?: ShipKitId | string;
  surveyorUtility?: unknown;
}): SurveyorUtilityId {
  if (host.kitId !== 'surveyor') {
    return DEFAULT_SURVEYOR_UTILITY;
  }
  return isSurveyorUtilityId(host.surveyorUtility)
    ? host.surveyorUtility
    : DEFAULT_SURVEYOR_UTILITY;
}

export function preferredSurveyorUtility(): SurveyorUtilityId {
  const stored = getStoredItem(SURVEYOR_UTILITY_STORAGE_KEY);
  return stored === null ? DEFAULT_SURVEYOR_UTILITY : parseSurveyorUtilityId(stored);
}

export function rememberSurveyorUtility(utilityId: SurveyorUtilityId): void {
  setStoredItem(SURVEYOR_UTILITY_STORAGE_KEY, utilityId);
}
