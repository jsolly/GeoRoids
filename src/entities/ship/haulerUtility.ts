import type { HaulerUtilityId, ShipKitId } from '../../../shared-types';
import { getStoredItem, setStoredItem } from '../../utils/safeStorage';

export const HAULER_UTILITY_IDS = ['tow_cable', 'resource_tap', 'boost_coupling'] as const;

/** New Hauler flights start on Resource Tap. */
export const PREFERRED_HAULER_UTILITY: HaulerUtilityId = 'resource_tap';
/** Missing snapshot / legacy host keeps the existing tow cable. */
export const UNSET_HAULER_UTILITY: HaulerUtilityId = 'tow_cable';

export const HAULER_UTILITY_STORAGE_KEY = 'georoids.haulerUtility';

export const HAULER_UTILITY = {
  boost_coupling: {
    id: 'boost_coupling',
    name: 'Boost Coupling',
    hint: 'Tap to equip',
    copy: 'Aim; E or ARM locks heading. E or IGNITE launches a 3-second burn. Swap tools to cancel before ignition.',
  },
  resource_tap: {
    id: 'resource_tap',
    name: 'Resource Tap',
    hint: 'Tap to equip',
    copy: 'Harpoon a roid to extract resources. Keeps the asteroid intact.',
  },
  tow_cable: {
    id: 'tow_cable',
    name: 'Tow Cable',
    hint: 'Tap to equip',
    copy: 'Latch and haul a rock (or wreck).',
  },
} as const;

export function isHaulerUtilityId(value: unknown): value is HaulerUtilityId {
  return value === 'resource_tap' || value === 'tow_cable' || value === 'boost_coupling';
}

export function parseHaulerUtilityId(value: unknown): HaulerUtilityId {
  return isHaulerUtilityId(value) ? value : UNSET_HAULER_UTILITY;
}

export function preferredHaulerUtility(): HaulerUtilityId {
  const stored = getStoredItem(HAULER_UTILITY_STORAGE_KEY);
  return stored ? parseHaulerUtilityId(stored) : PREFERRED_HAULER_UTILITY;
}

export function rememberHaulerUtility(utilityId: HaulerUtilityId): void {
  setStoredItem(HAULER_UTILITY_STORAGE_KEY, utilityId);
}

export function haulerUtilityOf(host: {
  kitId?: ShipKitId | string;
  haulerUtility?: HaulerUtilityId | null;
}): HaulerUtilityId {
  if (host.kitId !== 'hauler') {
    return UNSET_HAULER_UTILITY;
  }
  return isHaulerUtilityId(host.haulerUtility) ? host.haulerUtility : UNSET_HAULER_UTILITY;
}

export function isTowCableUtility(host: {
  kitId?: ShipKitId | string;
  haulerUtility?: HaulerUtilityId | null;
}): boolean {
  return host.kitId === 'hauler' && haulerUtilityOf(host) === 'tow_cable';
}

export function isResourceTapUtility(host: {
  kitId?: ShipKitId | string;
  haulerUtility?: HaulerUtilityId | null;
}): boolean {
  return host.kitId === 'hauler' && haulerUtilityOf(host) === 'resource_tap';
}
