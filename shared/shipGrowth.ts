import { SHIP } from '../src/constants';

/**
 * Slither-style size/mass growth shared by humans and bots.
 * Soft max keeps multiplayer readable: extra mass still collects, but size
 * and HP approach a cap instead of growing without bound.
 */
export const GROWTH = {
  BASE_MASS: 1,
  SOFT_MAX_MASS: 8,
  /** Always drop at least this much so a fresh-ship kill still yields loot. */
  BASE_KILL_MASS: 0.4,
  /** Fraction of growable mass (above BASE) converted to pellets. */
  DROP_FRACTION: 0.85,
  PELLET_MASS: 0.4,
  /** Small nibble from a destroyed roid — uses the same collect/growth path. */
  SHARD_MASS: 0.25,
  SHARD_SCORE: 5,
  MAX_PELLETS: 7,
  LOOT_RADIUS: 7,
  SCATTER_MIN: 16,
  SCATTER_MAX: 40,
  MAX_LOOT: 48,
  LOOT_TTL_FRAMES: 20 * 60,
  MAX_SIZE_SCALE: 2.2,
  MIN_THRUST_SCALE: 0.55,
  MIN_SPEED_SCALE: 0.6,
  MASS_GAIN_K: 0.45,
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

export function applyLootMass(current: number, gain: number): number {
  const cur = clampMass(current);
  const added = Math.max(0, gain);
  if (added === 0) {
    return Math.min(cur, GROWTH.SOFT_MAX_MASS);
  }
  const headroom = GROWTH.SOFT_MAX_MASS - cur;
  if (headroom <= 0) {
    return GROWTH.SOFT_MAX_MASS;
  }
  return Math.min(
    GROWTH.SOFT_MAX_MASS,
    cur + headroom * (1 - Math.exp(-GROWTH.MASS_GAIN_K * added))
  );
}

export function sizeScaleFromMass(mass: number): number {
  const span = GROWTH.SOFT_MAX_MASS - GROWTH.BASE_MASS;
  const t = (clampMass(mass) - GROWTH.BASE_MASS) / span;
  const u = Math.max(0, Math.min(1, t));
  return 1 + (GROWTH.MAX_SIZE_SCALE - 1) * u;
}

export function radiusFromMass(mass: number): number {
  return (SHIP.SIZE / 2) * sizeScaleFromMass(mass);
}

export function maxHealthFromMass(mass: number): number {
  return Math.round(SHIP.MAX_HEALTH * sizeScaleFromMass(mass));
}

export function thrustScaleFromMass(mass: number): number {
  const span = GROWTH.MAX_SIZE_SCALE - 1;
  const t = span <= 0 ? 0 : (sizeScaleFromMass(mass) - 1) / span;
  return 1 - (1 - GROWTH.MIN_THRUST_SCALE) * t;
}

export function maxVelocityFromMass(mass: number): number {
  const span = GROWTH.MAX_SIZE_SCALE - 1;
  const t = span <= 0 ? 0 : (sizeScaleFromMass(mass) - 1) / span;
  return SHIP.MAX_VELOCITY * (1 - (1 - GROWTH.MIN_SPEED_SCALE) * t);
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

export function planKillLoot(mass: number): { pelletMasses: number[] } {
  const extra = Math.max(0, clampMass(mass) - GROWTH.BASE_MASS);
  const total = extra * GROWTH.DROP_FRACTION + GROWTH.BASE_KILL_MASS;
  const count = Math.max(1, Math.min(GROWTH.MAX_PELLETS, Math.round(total / GROWTH.PELLET_MASS)));
  const each = total / count;
  return { pelletMasses: Array.from({ length: count }, () => each) };
}

export function canCollectLoot(entity: {
  exploding: boolean;
  health: number;
  respawnTimer?: number;
}): boolean {
  return !entity.exploding && entity.health > 0 && entity.respawnTimer === undefined;
}

export function lootOverlap(
  shipPosition: { x: number; y: number },
  shipMass: number,
  lootPosition: { x: number; y: number },
  lootRadius: number
): boolean {
  const reach = radiusFromMass(shipMass) + lootRadius;
  const dx = shipPosition.x - lootPosition.x;
  const dy = shipPosition.y - lootPosition.y;
  return dx * dx + dy * dy <= reach * reach;
}
