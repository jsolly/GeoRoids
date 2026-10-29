/** Activation cooldown starts with the shield, not when protection expires. */
export const PLAYER_SHIELD = { durationFrames: 120, cooldownFrames: 720 } as const;

interface ShieldState {
  shieldFrames?: number;
  shieldCooldownFrames?: number;
}

export function activatePlayerShield(host: ShieldState): boolean {
  if ((host.shieldCooldownFrames ?? 0) > 0 || (host.shieldFrames ?? 0) > 0) {
    return false;
  }
  host.shieldFrames = PLAYER_SHIELD.durationFrames;
  host.shieldCooldownFrames = PLAYER_SHIELD.cooldownFrames;
  return true;
}

export function tickPlayerShield(host: ShieldState): void {
  host.shieldFrames = Math.max(0, (host.shieldFrames ?? 0) - 1);
  host.shieldCooldownFrames = Math.max(0, (host.shieldCooldownFrames ?? 0) - 1);
}
