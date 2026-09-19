import type { HaulerUtilityId, ShipKitId } from '../../shared-types';
import { haulerUtilityOf } from '../entities/ship/haulerUtility';
import { getShipKit, SHIP_ABILITY, type ShipAbilityId } from '../entities/ship/shipKits';

const ABILITY_LABEL: Record<ShipAbilityId, string> = { surveyScan: 'SCAN', harpoon: 'HOOK' };
const HAULER_READY_LABEL: Record<HaulerUtilityId, string> = {
  resource_tap: 'TAP',
  boost_coupling: 'ARM',
  tow_cable: 'HOOK',
};

type AbilityChromeHost = {
  kitId: ShipKitId | string;
  exploding: boolean;
  health: number;
  abilityCooldownFrames: number;
  abilityActiveFrames: number;
  harpoonTargetId?: string | null;
  haulerUtility?: HaulerUtilityId | null;
};

type AbilityChromeState = {
  label: string;
  name: string;
  ready: boolean;
  active: boolean;
  cooling: boolean;
  unavailable: boolean;
  cooldownRatio: number;
};

/** Short phosphor label for the on-screen kit button. */
export function touchAbilityLabel(kitId: unknown): string {
  return ABILITY_LABEL[getShipKit(kitId).abilityId];
}

export function touchAbilityName(kitId: unknown): string {
  const kit = getShipKit(kitId);
  return kit.abilityName;
}

function abilityCooldownRatio(
  kitId: unknown,
  cooldownFrames: number,
  maxFrames: number = SHIP_ABILITY.COOLDOWN_FRAMES[getShipKit(kitId).id]
): number {
  if (!Number.isFinite(cooldownFrames) || !Number.isFinite(maxFrames) || maxFrames <= 0) {
    return 0;
  }
  return Math.min(1, Math.max(0, cooldownFrames / maxFrames));
}

export function readAbilityChrome(host: AbilityChromeHost): AbilityChromeState {
  const kit = getShipKit(host.kitId);
  const alive = !host.exploding && Number.isFinite(host.health) && host.health > 0;
  const cooling = Number.isFinite(host.abilityCooldownFrames) && host.abilityCooldownFrames > 0;
  const unavailable = !alive;
  const towing = kit.id === 'hauler' && Boolean(host.harpoonTargetId);
  const readyLabel =
    kit.id === 'hauler' ? HAULER_READY_LABEL[haulerUtilityOf(host)] : ABILITY_LABEL[kit.abilityId];
  const active =
    towing || (Number.isFinite(host.abilityActiveFrames) && host.abilityActiveFrames > 0);
  return {
    label: towing
      ? haulerUtilityOf(host) === 'boost_coupling'
        ? 'IGNITE'
        : 'RELEASE'
      : readyLabel,
    name: towing
      ? haulerUtilityOf(host) === 'boost_coupling'
        ? 'Ignite asteroid boost'
        : 'Release asteroid'
      : kit.id === 'hauler' && haulerUtilityOf(host) === 'boost_coupling'
        ? 'Arm asteroid boost'
        : touchAbilityName(kit.id),
    ready: alive && (towing || !cooling),
    active,
    cooling,
    unavailable,
    cooldownRatio: towing ? 0 : abilityCooldownRatio(kit.id, host.abilityCooldownFrames),
  };
}
