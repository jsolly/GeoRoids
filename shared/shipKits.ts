import type { ShipKitId } from '../shared-types';
import { GAME, SHIP } from './constants/gameplay';

export const SHIP_KIT_IDS = ['scout', 'hauler'] as const;

export const DEFAULT_SHIP_KIT_ID: ShipKitId = 'scout';

export type ShipAbilityId = 'surveyScan' | 'harpoon';

interface ShipKit {
  id: ShipKitId;
  name: string;
  abilityId: ShipAbilityId;
  abilityName: string;
  maxHealth: number;
  size: number;
  shotCooldown: number;
}

/** Linear playfield size vs Scout (`SHIP.SIZE`). Product bar: ~2× barge. */
export const HAULER_TO_SCOUT_SIZE = 2;

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
    maxHealth: SHIP.MAX_HEALTH,
    size: SHIP.SIZE,
    shotCooldown: 250,
  },
  hauler: {
    id: 'hauler',
    name: 'Hauler',
    abilityId: 'harpoon',
    abilityName: 'Harpoon',
    maxHealth: 140,
    size: SHIP.SIZE * HAULER_TO_SCOUT_SIZE,
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
  return kit;
}
