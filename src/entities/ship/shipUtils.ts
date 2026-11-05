import { GAME, SHIP } from '../../../shared/constants/gameplay';
import type { Position, Velocity } from '../../../shared-types';
import { addPositions, createPositionFromAngle } from '../../utils/mathUtils';

/** Minimal ship shape shared by local and remote players. */
interface ShipCollisionState {
  exploding: boolean;
  health: number;
  blinkCount: number;
  movementLocked?: boolean;
}

interface ShipSpawnProtectionState {
  blinkCount: number;
  spawnProtectionTimer: number;
  setBlinkOn(): void;
}

interface SharedShipCombatVisuals extends ShipSpawnProtectionState {
  exploding: boolean;
  explodeTime: number;
  health: number;
  explode(): void;
}

interface ShipImpactFlashState {
  impactFlashFrames: number;
}

/** Only a positive timer is an active respawn countdown. Omitted or 0 is not dead. */
export function isServerRespawnActive(respawnTimer?: number): boolean {
  return respawnTimer !== undefined && respawnTimer > 0;
}

/** Explode / clear the exploding flag. Shared by local and remote ships. */
export function applySharedShipExplodingFlag(
  ship: Pick<SharedShipCombatVisuals, 'exploding' | 'health' | 'explode'>,
  exploding: boolean | undefined
): void {
  if (exploding === true) {
    // Hitch catch-up can finish the local FX while the server is still
    // exploding. Do not rewind explodeTime — that restacked the death window.
    if (!ship.exploding && ship.health > 0) {
      ship.explode();
    }
    return;
  }
  if (exploding === false) {
    ship.exploding = false;
  }
}

/** True when the hull should be drawn — not an explosion and not a dead corpse. */
export function shouldDrawShipHull(ship: { exploding: boolean; health: number }): boolean {
  return !ship.exploding && ship.health > 0;
}

/** Arm blink after death→alive. Leftover server timers sync remaining frames only. */
export function applySharedShipRespawnCue(
  ship: SharedShipCombatVisuals,
  wasDeadOrExploding: boolean,
  spawnProtectionTimer?: number
): void {
  if (wasDeadOrExploding && ship.health > 0) {
    if (ship.exploding) {
      ship.exploding = false;
      ship.explodeTime = 0;
    }
    applyShipSpawnProtection(ship);
    return;
  }
  if (ship.health <= 0 || spawnProtectionTimer === undefined) {
    return;
  }
  if (spawnProtectionTimer <= 0) {
    clearShipSpawnProtection(ship);
    return;
  }
  if (ship.blinkCount <= 0) {
    applyShipSpawnProtectionForRemainingFrames(ship, spawnProtectionTimer);
  }
}

interface OverlayHoldShip extends ShipSpawnProtectionState {
  exploding: boolean;
  health: number;
  movementLocked: boolean;
  velocity: Velocity;
  angularVelocity: number;
  thrusting: boolean;
  releaseContourLock(): void;
}

/** True when a ship must not register a collision impact. */
export function isShipCollisionImmune(ship: ShipCollisionState): boolean {
  return ship.exploding || ship.health <= 0 || ship.blinkCount > 0 || ship.movementLocked === true;
}

/**
 * Freeze the local hull while the map, schematic, or town store is open. Closing arms the
 * same blink window as a respawn so an overlapping rock cannot kill immediately.
 * Returns true when the hold state changed.
 */
export function applyLocalOverlayHold(ship: OverlayHoldShip, held: boolean): boolean {
  const wasHeld = ship.movementLocked;
  ship.movementLocked = held;
  if (held) {
    ship.releaseContourLock();
    ship.velocity = { x: 0, y: 0 };
    ship.angularVelocity = 0;
    ship.thrusting = false;
  } else if (wasHeld && !ship.exploding && ship.health > 0) {
    applyShipSpawnProtection(ship);
  }
  return wasHeld !== held;
}

/** Arm the client blink window used after respawn. */
export function applyShipSpawnProtection(ship: ShipSpawnProtectionState): void {
  applyShipSpawnProtectionForRemainingFrames(ship, SHIP.INVINCIBILITY_DURATION_FRAMES);
}

/** Drop leftover blink so a finished server timer cannot restack invuln. */
export function clearShipSpawnProtection(ship: ShipSpawnProtectionState): void {
  ship.blinkCount = 0;
  ship.spawnProtectionTimer = 0;
}

/** Match client blink to the remaining server protection window — never a full restack. */
export function applyShipSpawnProtectionForRemainingFrames(
  ship: ShipSpawnProtectionState,
  remainingFrames: number
): void {
  const frames = Math.max(0, Math.floor(remainingFrames));
  if (frames <= 0) {
    clearShipSpawnProtection(ship);
    return;
  }
  const blink = SHIP.INVINCIBILITY_BLINK_DURATION_FRAMES;
  ship.blinkCount = Math.ceil(frames / blink);
  const phase = frames % blink;
  ship.spawnProtectionTimer = phase === 0 ? blink : phase;
  ship.setBlinkOn();
}

/**
 * playerDamaged must never raise health. Ignored hits (spawn protection)
 * still arrive with remainingHealth=100 and would "heal" a dead ship at
 * the death pose, skipping the blink arm in updateFromServer.
 */
export function shouldApplyDamagedHealth(
  currentHealth: number,
  remainingHealth: number,
  isDestroyed: boolean
): boolean {
  return isDestroyed || remainingHealth < currentHealth;
}

/** Short phosphor ring so a roid graze is visible before the server health packet. */
export function applyShipImpactFlash(ship: ShipImpactFlashState): void {
  ship.impactFlashFrames = SHIP.IMPACT_FLASH_FRAMES;
}

export function tickShipImpactFlash(ship: ShipImpactFlashState): void {
  if (ship.impactFlashFrames > 0) {
    ship.impactFlashFrames -= 1;
  }
}

export function calculateHealthAfterDamage(
  currentHealth: number,
  damage: number,
  maxHealth: number
): number {
  const afterDamage = currentHealth - damage;
  // Clamp between 0 and maxHealth
  return Math.min(maxHealth, Math.max(0, afterDamage));
}

export function calculateLaserStartPosition(
  shipPosition: Position,
  shipAngle: number,
  shipRadius: number
): Position {
  const noseOffset = createPositionFromAngle(shipAngle, (4 / 3) * shipRadius);
  return addPositions(shipPosition, noseOffset);
}

/**
 * Thrust / friction step for ships carrying combat knockback.
 * Callers pass their own friction so local and server-owned policies stay explicit.
 */
export function applyThrustOrFriction(
  velocity: Velocity,
  angle: number,
  thrusting: boolean,
  frictionCoefficient: number,
  maxVelocity: number = SHIP.MAX_VELOCITY
): Velocity {
  if (thrusting) {
    const nextX = velocity.x + (Math.cos(angle) * SHIP.THRUST) / GAME.FPS;
    const nextY = velocity.y - (Math.sin(angle) * SHIP.THRUST) / GAME.FPS;
    const currentSpeed = Math.hypot(nextX, nextY);
    if (currentSpeed > maxVelocity) {
      const scale = maxVelocity / currentSpeed;
      return { x: nextX * scale, y: nextY * scale };
    }
    return { x: nextX, y: nextY };
  }
  const frictionScale = 1 - frictionCoefficient / GAME.FPS;
  return { x: velocity.x * frictionScale, y: velocity.y * frictionScale };
}
