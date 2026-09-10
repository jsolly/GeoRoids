import { FUEL } from '../constants';
import {
  getShipKit,
  SHIP_ABILITY,
  type ShipAbilityId,
  type ShipKitId,
} from '../entities/ship/shipKits';
import {
  canActivateShield,
  isShieldBlockingLasers,
  type ShieldState,
  shieldCooldownFrames,
} from '../entities/ship/shipShield';

const ABILITY_LABEL: Record<ShipAbilityId, string> = {
  boostDash: 'DASH',
  harpoon: 'HOOK',
  shieldFocus: 'ABSORB',
  burstFire: 'BURST',
  shockPulse: 'PULSE',
};

type AbilityChromeHost = {
  kitId: ShipKitId | string;
  exploding: boolean;
  health: number;
  abilityCooldownFrames: number;
  abilityActiveFrames: number;
  fuel?: number;
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

type ShieldChromeHost = ShieldState & {
  exploding: boolean;
  health: number;
};

type ShieldChromeState = {
  label: 'SHIELD';
  name: 'Shield bubble';
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
  return kit.abilityId === 'shieldFocus' ? 'Timed absorb shield' : kit.abilityName;
}

export function abilityCooldownRatio(
  kitId: unknown,
  cooldownFrames: number,
  maxFrames: number = SHIP_ABILITY.COOLDOWN_FRAMES[getShipKit(kitId).id]
): number {
  if (!Number.isFinite(cooldownFrames) || !Number.isFinite(maxFrames) || maxFrames <= 0) {
    return 0;
  }
  return Math.min(1, Math.max(0, cooldownFrames / maxFrames));
}

export function canAffordTouchAbility(host: AbilityChromeHost): boolean {
  const kit = getShipKit(host.kitId);
  if (kit.abilityId !== 'shockPulse') {
    return true;
  }
  if (host.fuel === undefined) {
    return true;
  }
  return Number.isFinite(host.fuel) && host.fuel >= FUEL.EMP_COST;
}

export function readAbilityChrome(host: AbilityChromeHost): AbilityChromeState {
  const kit = getShipKit(host.kitId);
  const alive = !host.exploding && Number.isFinite(host.health) && host.health > 0;
  const cooling = Number.isFinite(host.abilityCooldownFrames) && host.abilityCooldownFrames > 0;
  const unavailable = !alive || !canAffordTouchAbility(host);
  const active = Number.isFinite(host.abilityActiveFrames) && host.abilityActiveFrames > 0;
  return {
    label: ABILITY_LABEL[kit.abilityId],
    name: touchAbilityName(kit.id),
    ready: alive && !cooling && !unavailable,
    active,
    cooling,
    unavailable,
    cooldownRatio: abilityCooldownRatio(kit.id, host.abilityCooldownFrames),
  };
}

export function shieldCooldownRatio(cooldownFrames: number): number {
  if (!Number.isFinite(cooldownFrames) || cooldownFrames <= 0) {
    return 0;
  }
  return Math.min(1, cooldownFrames / shieldCooldownFrames());
}

export function readShieldChrome(host: ShieldChromeHost): ShieldChromeState {
  const alive = !host.exploding && Number.isFinite(host.health) && host.health > 0;
  const active = isShieldBlockingLasers(host);
  const cooling = Number.isFinite(host.shieldCooldown) && host.shieldCooldown > 0;
  return {
    label: 'SHIELD',
    name: 'Shield bubble',
    ready: alive && (active || canActivateShield(host)),
    active,
    cooling,
    unavailable: !alive,
    cooldownRatio: shieldCooldownRatio(host.shieldCooldown),
  };
}
