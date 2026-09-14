import type { ShipKitId } from '../../../shared-types';
import { GAME, SHIP } from '../../constants';

export const SHIP_KIT_IDS = ['surveyor', 'hauler'] as const;

export const DEFAULT_SHIP_KIT_ID: ShipKitId = 'surveyor';

export type ShipAbilityId = 'surveyScan' | 'harpoon';

export interface HullProfile {
  nose: number;
  rear: number;
  beam: number;
}

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
  turnSpeed: number;
  shotCooldown: number;
}

/** Classic triangle. Kept for the leftover 3-point helper; play hulls use v2 outlines. */
export const CLASSIC_HULL: HullProfile = {
  nose: 1,
  rear: 0.8,
  beam: 0.5,
};

export const SHIP_HULL_TOPOLOGY = {
  surveyor: 'needle',
  hauler: 'barge-hex',
} as const;

export const SHIP_HULL_STYLE = { stroke: '#5EEAD4', background: '#000011' } as const;

/** Hauler cable. Game Director PASS: cream line, not a faction/hull stroke. */
export const HAULER_TETHER_COLOR = '#E8D5A3';
/** Latch tip / hook head. Game Director PASS: amber tip on the cream cable. */
export const HAULER_TETHER_TIP_COLOR = '#FDE68A';

export const SHIP_ABILITY = {
  HARPOON_RANGE: 280,
  /** Fallback "nearby" disk when the canvas size is unknown. */
  HARPOON_VISUAL_PX: 720,
  /**
   * Pull slack only. Latch reach is on-screen (half-diagonal / scale).
   * #480/#481 caps (1600 then 8000) still dropped a 1080p rock that sat
   * on-canvas under deep zoom (scale < 0.14).
   */
  HARPOON_RANGE_MAX: 1_000_000,
  HARPOON_FRAMES: 90,
  HARPOON_PULL: 0.42 * GAME.MOTION_SCALE,
  HARPOON_SLING_SPEED: 12 * GAME.MOTION_SCALE,
  /** Keep the same reachable targets at the slower sling speed. */
  HARPOON_INTERCEPT_FRAMES: Math.ceil(120 / GAME.MOTION_SCALE),
  HARPOON_PATH_ALIGNMENT: Math.cos(Math.PI / 12),
  HARPOON_REEL_SPEED: 16 * GAME.MOTION_SCALE,
  HARPOON_REEL_ACCELERATION: 1.2 * GAME.MOTION_SCALE,
  HARPOON_RELEASE_GAP: 16,
  HARPOON_SLACK: 1.25,
  SCAN_RANGE: 1200,
  SCAN_FRAMES: 6 * GAME.FPS,
  ASTEROID_DAMAGE_MULTIPLIER: 2,
  COOLDOWN_FRAMES: {
    surveyor: 10 * GAME.FPS,
    hauler: 180,
  },
} as const;

const KITS: Record<ShipKitId, ShipKit> = {
  surveyor: {
    id: 'surveyor',
    name: 'Surveyor',
    abilityId: 'surveyScan',
    abilityName: 'Mineral scan',
    abilityHint: 'Nimble flight and mineral scanning',
    maxHealth: SHIP.MAX_HEALTH,
    size: SHIP.SIZE,
    thrust: SHIP.THRUST,
    maxVelocity: SHIP.MAX_VELOCITY,
    turnSpeed: 540,
    shotCooldown: 250,
  },
  hauler: {
    id: 'hauler',
    name: 'Hauler',
    abilityId: 'harpoon',
    abilityName: 'Harpoon',
    abilityHint: 'Tow, throw, and mine asteroids',
    maxHealth: 140,
    size: 38,
    thrust: 4.5 * GAME.MOTION_SCALE,
    maxVelocity: 1.75 * GAME.MOTION_SCALE,
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

/** Shared human + bot kit application. Does not touch playfield colors. */
export function applyShipKitStats(target: KitStatTarget, kitId: unknown): ShipKit {
  const kit = getShipKit(kitId);
  target.kitId = kit.id;
  target.maxHealth = kit.maxHealth;
  target.health = kit.maxHealth;
  return kit;
}

export function applyShipKitToShip(ship: KitShipTarget, kitId: unknown): ShipKit {
  const kit = applyShipKitStats(ship, kitId);
  ship.r = kit.size / 2;
  ship.shotCooldown = kit.shotCooldown;
  ship.thrust = kit.thrust;
  ship.maxVelocity = kit.maxVelocity;
  ship.turnSpeed = kit.turnSpeed;
  return kit;
}
