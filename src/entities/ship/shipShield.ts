import type { ShipKitId } from '../../../shared-types';
import { GAME, SHIELD } from '../../constants';

export type CombatDamageSource = 'laser' | 'collision';

export interface ShieldState {
  shieldActive: boolean;
  shieldTime: number;
  shieldCooldown: number;
  shieldFlashTime: number;
}

export function createShieldState(): ShieldState {
  return {
    shieldActive: false,
    shieldTime: 0,
    shieldCooldown: 0,
    shieldFlashTime: 0,
  };
}

export function shieldDurationFrames(kitId?: ShipKitId): number {
  const durationSeconds =
    kitId === 'warden' ? SHIELD.WARDEN_DURATION_SECONDS : SHIELD.DURATION_SECONDS;
  return Math.ceil(durationSeconds * GAME.FPS);
}

export function shieldCooldownFrames(): number {
  return Math.ceil(SHIELD.COOLDOWN_SECONDS * GAME.FPS);
}

export function shieldFlashFrames(): number {
  return Math.ceil(SHIELD.FLASH_SECONDS * GAME.FPS);
}

export function shieldSnapshot(state: ShieldState): ShieldState {
  return {
    shieldActive: state.shieldActive,
    shieldTime: state.shieldTime,
    shieldCooldown: state.shieldCooldown,
    shieldFlashTime: state.shieldFlashTime,
  };
}

export function applyShieldSnapshot(state: ShieldState, snapshot: Partial<ShieldState>): void {
  if (snapshot.shieldActive !== undefined) {
    state.shieldActive = snapshot.shieldActive;
  }
  if (snapshot.shieldTime !== undefined) {
    state.shieldTime = snapshot.shieldTime;
  }
  if (snapshot.shieldCooldown !== undefined) {
    state.shieldCooldown = snapshot.shieldCooldown;
  }
  if (snapshot.shieldFlashTime !== undefined) {
    state.shieldFlashTime = snapshot.shieldFlashTime;
  }
}

export function canActivateShield(state: ShieldState, exploding = false): boolean {
  return !exploding && !state.shieldActive && state.shieldCooldown <= 0;
}

export function activateShield(state: ShieldState, exploding = false, kitId?: ShipKitId): boolean {
  if (!canActivateShield(state, exploding)) {
    return false;
  }
  state.shieldActive = true;
  state.shieldTime = shieldDurationFrames(kitId);
  return true;
}

export function deactivateShield(state: ShieldState): void {
  if (!state.shieldActive) {
    return;
  }
  state.shieldActive = false;
  state.shieldTime = 0;
  state.shieldCooldown = shieldCooldownFrames();
}

export function requestShield(
  state: ShieldState,
  active: boolean,
  exploding = false,
  kitId?: ShipKitId
): boolean {
  if (active) {
    return activateShield(state, exploding, kitId);
  }
  if (!state.shieldActive) {
    return false;
  }
  deactivateShield(state);
  return true;
}

export function updateShield(state: ShieldState): void {
  if (state.shieldFlashTime > 0) {
    state.shieldFlashTime--;
  }
  if (state.shieldActive) {
    state.shieldTime--;
    if (state.shieldTime <= 0) {
      deactivateShield(state);
    }
    return;
  }
  if (state.shieldCooldown > 0) {
    state.shieldCooldown--;
  }
}

export function isShieldBlockingLasers(state: ShieldState): boolean {
  return state.shieldActive && state.shieldTime > 0;
}

/** One visual predicate for the F bubble and Warden's independent E timer. */
export function isReadableShieldUp(state: ShieldState & { shieldTimer?: number }): boolean {
  return isShieldBlockingLasers(state) || (state.shieldTimer ?? 0) > 0;
}

function isEnvironmentalAttacker(attackerId: string): boolean {
  return attackerId === 'asteroid' || attackerId === 'boundary';
}

export function resolveCombatDamageSource(
  attackerId: string,
  source?: CombatDamageSource
): CombatDamageSource {
  if (source) {
    return source;
  }
  return isEnvironmentalAttacker(attackerId) ? 'collision' : 'laser';
}

export function noteShieldLaserHit(state: ShieldState): void {
  if (isShieldBlockingLasers(state)) {
    state.shieldFlashTime = shieldFlashFrames();
  }
}

/** Record an enemy laser impact for either shield mechanic's shared ring. */
export function noteReadableShieldLaserHit(state: ShieldState & { shieldTimer?: number }): void {
  if (isReadableShieldUp(state)) {
    state.shieldFlashTime = shieldFlashFrames();
  }
}

export function clearShield(state: ShieldState): void {
  state.shieldActive = false;
  state.shieldTime = 0;
  state.shieldCooldown = 0;
  state.shieldFlashTime = 0;
}

export function laserCollisionRadius(
  shipRadius: number,
  state: ShieldState & { shieldTimer?: number }
): number {
  if (isReadableShieldUp(state)) {
    return shipRadius * SHIELD.RADIUS_RATIO;
  }
  return shipRadius;
}

/**
 * Shared bot/player decision: raise the same shield when hull is low.
 * `rng` must return [0, 1); inject a stub in tests.
 */
export function maybeActivateBotShield(
  state: ShieldState & {
    health: number;
    maxHealth: number;
    exploding: boolean;
    kitId?: ShipKitId;
  },
  rng: () => number
): boolean {
  if (state.exploding || state.health <= 0) {
    return false;
  }
  if (state.health > state.maxHealth * SHIELD.BOT_HEALTH_THRESHOLD) {
    return false;
  }
  if (rng() >= SHIELD.BOT_ACTIVATE_CHANCE) {
    return false;
  }
  return activateShield(state, state.exploding, state.kitId);
}
