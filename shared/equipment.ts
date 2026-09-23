import type { EquipmentId, HaulerUtilityId, ScoutUtilityId } from '../shared-types';

/** Rare salvage. Starter tools never need a drop. */
export const EQUIPMENT = {
  resource_tap: { name: 'Resource Tap', kitId: 'hauler' },
  boost_coupling: { name: 'Boost Coupling', kitId: 'hauler' },
  survey_probe: { name: 'Survey Probe', kitId: 'scout' },
} as const;

export const EQUIPMENT_IDS = ['resource_tap', 'boost_coupling', 'survey_probe'] as const;

export const EQUIPMENT_DROPS = {
  RADIUS: 22,
  ASTEROID_CHANCE: 0.015,
  NEST_CHANCE: 0.65,
  NEST_LIFETIME_FRAMES: 30 * 60 * 60,
} as const;

export function isEquipmentId(value: unknown): value is EquipmentId {
  return value === 'resource_tap' || value === 'boost_coupling' || value === 'survey_probe';
}

export function validEquipment(value: unknown): value is EquipmentId[] {
  return (
    Array.isArray(value) &&
    value.length <= EQUIPMENT_IDS.length &&
    value.every(isEquipmentId) &&
    new Set(value).size === value.length
  );
}

export function canEquipUtility(
  host: { kitId?: string; equipment?: readonly EquipmentId[] },
  utility: unknown
): utility is HaulerUtilityId | ScoutUtilityId {
  if (utility === 'tow_cable') {
    return host.kitId === 'hauler';
  }
  if (utility === 'mineral_scan') {
    return host.kitId === 'scout';
  }
  return (
    isEquipmentId(utility) &&
    EQUIPMENT[utility].kitId === host.kitId &&
    (host.equipment?.includes(utility) ?? false)
  );
}
