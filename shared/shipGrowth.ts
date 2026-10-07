import type { Position, ShipKitId } from '../shared-types';
import { GAME, SHIP } from '../src/constants';
import { cargoCapacity } from './economy';

/**
 * Shared pickup rules and persisted ship mass, health, and handling. Hull draw size and collision
 * radius stay at the kit base; mass does not scale the silhouette.
 * Existing ship mass is bounded; collecting pickups does not change it.
 */
export const GROWTH = {
  BASE_MASS: 1,
  SOFT_MAX_MASS: 8,
  /** Small nibble from a destroyed roid — uses the same collection path. */
  SHARD_MASS: 0.25,
  SHARD_SCORE: 5,
  LOOT_RADIUS: 12,
  /** Outline canister from a Resource Tap extract. ~2.3× normal loot. */
  TAP_LOOT_RADIUS: 28,
  /** Four canisters keep the full extract at 0.4 mass and 8 points. */
  TAP_LOOT_MASS: 0.1,
  TAP_LOOT_SCORE: 2,
  /** Let the ejection read before magnetism or pickup can consume it. */
  TAP_LOOT_EJECT_FRAMES: 18,
  TAP_LOOT_MAGNET_RANGE: 160,
  TAP_LOOT_MAGNET_ACCEL: 0.12 * GAME.MOTION_SCALE,
  /** Pull loot toward living ships from beyond hull overlap without inflating the hull. */
  LOOT_MAGNET_RANGE: 80,
  LOOT_DRAG: 0.92,
  LOOT_MAGNET_ACCEL: 0.08 * GAME.MOTION_SCALE,
  MAX_LOOT: 192,
  LOOT_TTL_FRAMES: 20 * 60,
  /** Scout-base HP multiplier at SOFT_MAX_MASS. */
  MAX_HEALTH_SCALE: 2.2,
  MIN_THRUST_SCALE: 0.55,
  MIN_SPEED_SCALE: 0.6,
} as const;

interface GrowableShip {
  mass: number;
  health: number;
  maxHealth: number;
}

function clampMass(mass: number): number {
  if (!Number.isFinite(mass)) {
    return GROWTH.BASE_MASS;
  }
  return Math.max(GROWTH.BASE_MASS, mass);
}

function massProgress(mass: number): number {
  const span = GROWTH.SOFT_MAX_MASS - GROWTH.BASE_MASS;
  if (span <= 0) {
    return 0;
  }
  const t = (clampMass(mass) - GROWTH.BASE_MASS) / span;
  return Math.max(0, Math.min(1, t));
}

export function maxHealthFromMass(mass: number): number {
  return Math.round(SHIP.MAX_HEALTH * (1 + (GROWTH.MAX_HEALTH_SCALE - 1) * massProgress(mass)));
}

export function thrustScaleFromMass(mass: number): number {
  return 1 - (1 - GROWTH.MIN_THRUST_SCALE) * massProgress(mass);
}

export function maxVelocityFromMass(mass: number): number {
  return SHIP.MAX_VELOCITY * (1 - (1 - GROWTH.MIN_SPEED_SCALE) * massProgress(mass));
}

export function applyShipMass(ship: GrowableShip, nextMass: number): void {
  const prevMax = ship.maxHealth;
  ship.mass = Math.min(GROWTH.SOFT_MAX_MASS, clampMass(nextMass));
  ship.maxHealth = maxHealthFromMass(ship.mass);
  const gained = ship.maxHealth - prevMax;
  if (ship.health > 0 && gained > 0) {
    ship.health = Math.min(ship.maxHealth, ship.health + gained);
  } else if (ship.health > ship.maxHealth) {
    ship.health = ship.maxHealth;
  }
}

export function resetShipMass(ship: GrowableShip): void {
  ship.mass = GROWTH.BASE_MASS;
  ship.maxHealth = maxHealthFromMass(GROWTH.BASE_MASS);
}

export function canCollectLoot(entity: {
  exploding: boolean;
  health: number;
  respawnTimer?: number;
  overlayHold?: boolean;
  cargo?: number;
  kitId?: ShipKitId;
}): boolean {
  return (
    !entity.exploding &&
    entity.health > 0 &&
    entity.respawnTimer === undefined &&
    entity.overlayHold !== true &&
    (entity.cargo === undefined || entity.cargo < cargoCapacity(entity.kitId))
  );
}

export function lootOverlap(
  shipPosition: { x: number; y: number },
  shipRadius: number,
  lootPosition: { x: number; y: number },
  lootRadius: number
): boolean {
  const hull = Number.isFinite(shipRadius) && shipRadius > 0 ? shipRadius : 0;
  const reach = hull + lootRadius;
  const dx = shipPosition.x - lootPosition.x;
  const dy = shipPosition.y - lootPosition.y;
  return dx * dx + dy * dy <= reach * reach;
}

/** Add magnet acceleration toward the nearest collector. Leaves existing velocity intact. */
export function addLootMagnetPull(
  drop: { position: Position; velocity: { x: number; y: number } },
  collectorPositions: readonly Position[],
  options?: { range?: number; accel?: number }
): boolean {
  const range = options?.range ?? GROWTH.LOOT_MAGNET_RANGE;
  const accel = options?.accel ?? GROWTH.LOOT_MAGNET_ACCEL;
  const rangeSq = range * range;
  let best: { dx: number; dy: number; distSq: number } | undefined;
  for (const collector of collectorPositions) {
    const dx = collector.x - drop.position.x;
    const dy = collector.y - drop.position.y;
    const distSq = dx * dx + dy * dy;
    if (distSq > rangeSq || distSq < 1e-12) {
      continue;
    }
    if (!best || distSq < best.distSq) {
      best = { dx, dy, distSq };
    }
  }
  if (!best) {
    return false;
  }
  const scale = accel / Math.sqrt(best.distSq);
  drop.velocity.x += best.dx * scale;
  drop.velocity.y += best.dy * scale;
  return true;
}
