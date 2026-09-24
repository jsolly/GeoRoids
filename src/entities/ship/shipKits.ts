import type { ShipKitId } from '../../../shared-types';
import { GAME, SHIP } from '../../constants';

export const SHIP_KIT_IDS = ['scout', 'hauler'] as const;

export const DEFAULT_SHIP_KIT_ID: ShipKitId = 'scout';

export type ShipAbilityId = 'surveyScan' | 'harpoon';

interface ShipKit {
  id: ShipKitId;
  name: string;
  abilityId: ShipAbilityId;
  abilityName: string;
  abilityHint: string;
  maxHealth: number;
  size: number;
  thrust: number;
  maxVelocity: number;
  /** Multiplier on cruise speed and thrust while the Boost toggle is on. */
  boostMultiplier: number;
  turnSpeed: number;
  shotCooldown: number;
}

export const SHIP_HULL_TOPOLOGY = {
  scout: 'delta-wing',
  hauler: 'cargo-yoke',
} as const;

export const SHIP_HULL_STYLE = { stroke: '#5EEAD4', background: '#000011' } as const;

/** Linear playfield size vs Scout (`SHIP.SIZE`). Product bar: ~2× barge. */
export const HAULER_TO_SCOUT_SIZE = 2;

/** Hauler cable. Cream line separates the cable from the hull. */
export const HAULER_TETHER_COLOR = '#E8D5A3';
/** Latch tip / hook head. Game Director PASS: amber tip on the cream cable. */
export const HAULER_TETHER_TIP_COLOR = '#FDE68A';

export const SHIP_ABILITY = {
  HARPOON_RANGE: 280,
  /** Cable separation tolerance before cargo detaches. */
  HARPOON_SLACK: 1.25,
  /** Resource Tap extract completes after this latch duration. */
  TAP_EXTRACT_FRAMES: 90,
  TAP_EXTRACT_BURSTS: 4,
  SCAN_RANGE: 1200,
  /** Mineral Scan fires this many radar pulses, then ends. */
  SCAN_PULSES: 1,
  /** Active classification window: one pulse at the previous per-pulse speed. */
  SCAN_FRAMES: 2 * GAME.FPS,
  ASTEROID_DAMAGE_MULTIPLIER: 2,
  COOLDOWN_FRAMES: {
    /** Time from activation until Mineral Scan can fire again. */
    scout: 20 * GAME.FPS,
    hauler: 180,
  },
} as const;

const KITS: Record<ShipKitId, ShipKit> = {
  scout: {
    id: 'scout',
    name: 'Scout',
    abilityId: 'surveyScan',
    abilityName: 'Mineral scan',
    abilityHint: 'Start with Mineral Scan. Find Survey Probe in spider nests. V opens inventory.',
    maxHealth: SHIP.MAX_HEALTH,
    size: SHIP.SIZE,
    thrust: SHIP.THRUST,
    maxVelocity: SHIP.MAX_VELOCITY,
    boostMultiplier: 1.8,
    turnSpeed: 540,
    shotCooldown: 250,
  },
  hauler: {
    id: 'hauler',
    name: 'Hauler',
    abilityId: 'harpoon',
    abilityName: 'Harpoon',
    abilityHint:
      'Start with Tow Cable. Find Resource Tap and Boost Coupling in spider nests. V opens inventory.',
    maxHealth: 140,
    size: SHIP.SIZE * HAULER_TO_SCOUT_SIZE,
    thrust: 4.5 * GAME.MOTION_SCALE * GAME.PLAYER_SPEED_SCALE,
    maxVelocity: SHIP.MAX_VELOCITY,
    boostMultiplier: 1.35,
    turnSpeed: 380,
    shotCooldown: 280,
  },
};

export function isShipKitId(value: unknown): value is ShipKitId {
  return typeof value === 'string' && (SHIP_KIT_IDS as readonly string[]).includes(value);
}

export function parseShipKitId(value: unknown): ShipKitId {
  return isShipKitId(value) ? value : DEFAULT_SHIP_KIT_ID;
}

export function getShipKit(kitId: unknown): ShipKit {
  return KITS[parseShipKitId(kitId)];
}

export function listShipKits(): ShipKit[] {
  return SHIP_KIT_IDS.map((id) => KITS[id]);
}

interface KitStatTarget {
  kitId: ShipKitId;
  maxHealth: number;
  health: number;
}

interface KitShipTarget extends KitStatTarget {
  r: number;
  shotCooldown: number;
  thrust: number;
  maxVelocity: number;
  turnSpeed: number;
}

/** Draw, collision, latch, and loot all use this kit hull radius. */
export function hullRadiusForKit(kitId: unknown): number {
  return getShipKit(kitId).size / 2;
}

/** Shared kit application. Does not touch playfield colors. */
export function applyShipKitStats(target: KitStatTarget, kitId: unknown): ShipKit {
  const kit = getShipKit(kitId);
  target.kitId = kit.id;
  target.maxHealth = kit.maxHealth;
  target.health = kit.maxHealth;
  return kit;
}

export function applyShipKitToShip(ship: KitShipTarget, kitId: unknown): ShipKit {
  const kit = applyShipKitStats(ship, kitId);
  ship.r = hullRadiusForKit(kit.id);
  ship.shotCooldown = kit.shotCooldown;
  ship.thrust = kit.thrust;
  ship.maxVelocity = kit.maxVelocity;
  ship.turnSpeed = kit.turnSpeed;
  return kit;
}
