import { scoutAbilityBuildsAt } from '../../shared/furnaceField';
import { nearestTravelFurnace } from '../../shared/furnaceTravel';
import type { HaulerUtilityId, ScoutUtilityId, ShipKitId } from '../../shared-types';
import { haulerUtilityOf } from '../entities/ship/haulerUtility';
import { scoutUtilityOf } from '../entities/ship/scoutUtility';
import { abilityCooldownFramesFor } from '../entities/ship/shipAbilities';
import { getShipKit, SHIP_ABILITY, type ShipAbilityId } from '../entities/ship/shipKits';
import { worldFurnaces } from '../network/worldExploration';

const ABILITY_LABEL: Record<ShipAbilityId, string> = { surveyScan: 'SCAN', harpoon: 'HOOK' };
const SCOUT_ABILITY_LABEL: Record<ScoutUtilityId, string> = {
  mineral_scan: 'SCAN',
  survey_probe: 'PROBE',
};
const SCOUT_ABILITY_NAME: Record<ScoutUtilityId, string> = {
  mineral_scan: 'Mineral scan',
  survey_probe: 'Survey probe',
};
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
  scoutUtility?: ScoutUtilityId | null;
  furnaceTransit?: unknown;
  position?: { x: number; y: number };
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

function scoutOffersBuild(host: AbilityChromeHost): boolean {
  return (
    getShipKit(host.kitId).id === 'scout' &&
    host.position !== undefined &&
    scoutAbilityBuildsAt(host.position, (id) => worldFurnaces.isLit(id))
  );
}

/** Inside a lit furnace footprint, E and the ability button offer travel for either kit. */
function abilityOffersTownStore(host: AbilityChromeHost): boolean {
  return (
    !host.furnaceTransit &&
    !host.exploding &&
    Number.isFinite(host.health) &&
    host.health > 0 &&
    host.position !== undefined &&
    nearestTravelFurnace(host.position, worldFurnaces) !== undefined
  );
}

/** Short phosphor label for the on-screen kit button. */
export function touchAbilityLabel(kitId: unknown, utilityId?: unknown): string {
  const kit = getShipKit(kitId);
  if (kit.id === 'scout') {
    const utility = scoutUtilityOf({ kitId: kit.id, scoutUtility: utilityId });
    return SCOUT_ABILITY_LABEL[utility];
  }
  return ABILITY_LABEL[kit.abilityId];
}

export function touchAbilityName(kitId: unknown, utilityId?: unknown): string {
  const kit = getShipKit(kitId);
  if (kit.id === 'scout') {
    const utility = scoutUtilityOf({ kitId: kit.id, scoutUtility: utilityId });
    return SCOUT_ABILITY_NAME[utility];
  }
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
  const alive =
    !host.furnaceTransit && !host.exploding && Number.isFinite(host.health) && host.health > 0;
  const cooling = Number.isFinite(host.abilityCooldownFrames) && host.abilityCooldownFrames > 0;
  const unavailable = !alive;
  const offeringStore = abilityOffersTownStore(host);
  const towing = !offeringStore && kit.id === 'hauler' && Boolean(host.harpoonTargetId);
  const offeringBuild = !offeringStore && scoutOffersBuild(host);
  const readyLabel =
    kit.id === 'hauler' ? HAULER_READY_LABEL[haulerUtilityOf(host)] : ABILITY_LABEL[kit.abilityId];
  const active =
    towing || (Number.isFinite(host.abilityActiveFrames) && host.abilityActiveFrames > 0);
  return {
    label: towing
      ? haulerUtilityOf(host) === 'boost_coupling'
        ? 'IGNITE'
        : 'RELEASE'
      : offeringStore
        ? 'TRAVEL'
        : offeringBuild
          ? 'BUILD'
          : kit.id === 'scout'
            ? touchAbilityLabel(kit.id, host.scoutUtility)
            : readyLabel,
    name: towing
      ? haulerUtilityOf(host) === 'boost_coupling'
        ? 'Ignite asteroid boost'
        : 'Release asteroid'
      : offeringStore
        ? 'Choose furnace destination'
        : offeringBuild
          ? 'Build furnace'
          : kit.id === 'hauler' && haulerUtilityOf(host) === 'boost_coupling'
            ? 'Arm asteroid boost'
            : kit.id === 'scout'
              ? touchAbilityName(kit.id, host.scoutUtility)
              : touchAbilityName(kit.id),
    ready: alive && (towing || offeringStore || offeringBuild || !cooling),
    active,
    cooling: offeringStore || offeringBuild ? false : cooling,
    unavailable,
    cooldownRatio:
      towing || offeringStore || offeringBuild
        ? 0
        : abilityCooldownRatio(
            kit.id,
            host.abilityCooldownFrames,
            kit.id === 'scout' ? abilityCooldownFramesFor(host) : undefined
          ),
  };
}
