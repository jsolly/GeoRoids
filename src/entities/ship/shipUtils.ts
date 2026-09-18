import { GROWTH, maxVelocityFromMass, thrustScaleFromMass } from '../../../shared/shipGrowth';
import type { Position, Velocity } from '../../../shared-types';
import { GAME, SHIP } from '../../constants';
import { checkBoundaryCollision } from '../../physics/collision/collisionDetection';
import { isGenericDeathCause } from '../../utils/deathCause';
import { addPositions, createPositionFromAngle } from '../../utils/mathUtils';

/** Minimal ship shape shared by local and remote players. */
interface ShipCollisionState {
  exploding: boolean;
  health: number;
  blinkCount: number;
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
  explode(cause?: string): void;
}

interface ShipImpactFlashState {
  impactFlashFrames: number;
}

interface ShipLethalHitState extends ShipImpactFlashState {
  health: number;
  exploding: boolean;
  takeDamage(amount: number, cause?: string): void;
}

/** Only a positive timer is an active respawn countdown. Omitted or 0 is not dead. */
export function isServerRespawnActive(respawnTimer?: number): boolean {
  return respawnTimer !== undefined && respawnTimer > 0;
}

/**
 * Established session progress must not snap back to a fresh 3-life / 0-score
 * spawn unless this really is a new local player object.
 */
export function isSilentHudReset(
  currentLives: number,
  currentScore: number,
  incomingLives?: number,
  incomingScore?: number
): boolean {
  if (incomingLives === undefined && incomingScore === undefined) {
    return false;
  }
  const nextLives = incomingLives ?? currentLives;
  const nextScore = incomingScore ?? currentScore;
  // Game-over (0 lives) may start a new ship at 3/0; mid-run progress must not.
  const established = currentLives > 0 && (currentScore > 0 || currentLives < GAME.START_LIVES);
  return established && nextLives === GAME.START_LIVES && nextScore === GAME.STARTING_SCORE;
}

/** Explode / clear the exploding flag. Shared by local and remote ships. */
export function applySharedShipExplodingFlag(
  ship: Pick<SharedShipCombatVisuals, 'exploding' | 'health' | 'explode'>,
  exploding: boolean | undefined,
  cause = 'server-damage'
): void {
  if (exploding === true) {
    // Hitch catch-up can finish the local FX while the server is still
    // exploding. Do not rewind explodeTime — that restacked the death window.
    if (!ship.exploding && ship.health > 0) {
      ship.explode(cause);
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

/** Prefer a known cause; a hull past the arena edge is a wall death. */
export function resolveCombatDeathCause(
  known: string | undefined,
  ship?: { position: Position; r: number }
): string {
  if (known && !isGenericDeathCause(known)) {
    return known;
  }
  if (ship && checkBoundaryCollision(ship.position, ship.r)) {
    return 'boundary';
  }
  return known ?? 'unknown';
}

/** Predict wall contact while the server confirms the life loss. */
export function applyShipBoundaryDeath(ship: ShipLethalHitState): void {
  applyShipImpactFlash(ship);
  if (!ship.exploding) {
    ship.takeDamage(ship.health, 'boundary');
  }
}

/** True when a ship must not report or receive collision damage. */
export function isShipCollisionImmune(ship: ShipCollisionState): boolean {
  return ship.exploding || ship.health <= 0 || ship.blinkCount > 0;
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

export function calculateHealthAfterHeal(
  currentHealth: number,
  healAmount: number,
  maxHealth: number
): number {
  return Math.min(currentHealth + healAmount, maxHealth);
}

export function shouldStartHealthRegeneration(
  lastDamageTime: number,
  currentHealth: number,
  maxHealth: number
): boolean {
  // Dead ships (health 0) await server respawn — never regen locally from zero.
  return lastDamageTime <= 0 && currentHealth > 0 && currentHealth < maxHealth;
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
 * Scalar mass/kit arguments keep loot mass and Hauler thrust on the same
 * formula without allocating an options object on every frame.
 */
export function applyThrustOrFriction(
  velocity: Velocity,
  angle: number,
  thrusting: boolean,
  frictionCoefficient: number,
  thrust: number = SHIP.THRUST,
  mass: number = GROWTH.BASE_MASS,
  maxVelocity: number = SHIP.MAX_VELOCITY
): Velocity {
  if (thrusting) {
    const thrustScale = thrustScaleFromMass(mass);
    const massMax = maxVelocityFromMass(mass);
    const nextX = velocity.x + (Math.cos(angle) * thrust * thrustScale) / GAME.FPS;
    const nextY = velocity.y - (Math.sin(angle) * thrust * thrustScale) / GAME.FPS;
    const currentSpeed = Math.hypot(nextX, nextY);
    const speedCap = maxVelocity * (massMax / SHIP.MAX_VELOCITY);
    if (currentSpeed > speedCap) {
      const scale = speedCap / currentSpeed;
      return { x: nextX * scale, y: nextY * scale };
    }
    return { x: nextX, y: nextY };
  }
  const frictionScale = 1 - frictionCoefficient / GAME.FPS;
  return { x: velocity.x * frictionScale, y: velocity.y * frictionScale };
}
