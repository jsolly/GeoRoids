import type { ShipKitId } from '../../../shared-types';
import { SHIP } from '../../constants';

export type { ShipKitId };

export const SHIP_KIT_IDS = ['dart', 'hauler', 'warden', 'skirmisher', 'quake'] as const;

export const DEFAULT_SHIP_KIT_ID: ShipKitId = 'dart';

/** Ability flavor — geo is optional spice, not a kit requirement. */
export type ShipAbilityFlavor = 'combat' | 'utility' | 'geo';

export type ShipAbilityId = 'boostDash' | 'harpoon' | 'shieldFocus' | 'burstFire' | 'shockPulse';

export interface HullProfile {
  nose: number;
  rear: number;
  beam: number;
}

export interface ShipKit {
  id: ShipKitId;
  name: string;
  abilityId: ShipAbilityId;
  abilityName: string;
  abilityHint: string;
  flavor: ShipAbilityFlavor;
  maxHealth: number;
  size: number;
  thrust: number;
  maxVelocity: number;
  turnSpeed: number;
  shotCooldown: number;
  burstCount: number;
}

/** Classic triangle. Kept for the leftover 3-point helper; play hulls use v2 outlines. */
export const CLASSIC_HULL: HullProfile = {
  nose: 1,
  rear: 0.8,
  beam: 0.5,
};

/** Retired placeholder. Play kits bake from `hullOutlines.ts`, not this triangle. */
export const KIT_HULL_PLACEHOLDER = CLASSIC_HULL;
export const KIT_HULLS_ARE_PLACEHOLDERS = false;

/**
 * John lock 2026-09-06 via Game Director. Bake against v2 sheets only
 * (`ship-silhouettes-contact-v2` / `ship-silhouettes-play-scale-v2`).
 */
export const AD_V2_HULL_BAKE_LOCKED = true;

export const AD_V2_HULL_TOPOLOGY = {
  dart: 'needle',
  hauler: 'barge-hex',
  warden: 'delta-shield-arc',
  skirmisher: 'y-fork',
  quake: 'terraced-mountain',
} as const;

/** Sheet notes for the bake after lock. Not consumed by the renderer. */
export const AD_V2_HULL_SHEET = {
  stroke: '#5EEAD4',
  background: '#000011',
  playScalePx: 32,
  packDir: 'georoids-art/ships-v2',
  sheets: ['ship-silhouettes-contact-v2', 'ship-silhouettes-play-scale-v2'],
  topology: AD_V2_HULL_TOPOLOGY,
  notes: {
    dart: 'needle — tall thin isosceles, inverted-V notch at aft',
    hauler: 'barge hex — wide low polygon, flat keel, faceted bow',
    warden: 'delta + detached forward shield arc above the apex',
    skirmisher: 'Y-fork — two forward prongs, notched aft',
    quake: 'terraced mountain — triangular peak, cross ledges, narrow rear stem',
  },
} as const;

/** Hauler cable. Game Director PASS: cream line, not a faction/hull stroke. */
export const HAULER_TETHER_COLOR = '#E8D5A3';
/** Latch tip / hook head. Game Director PASS: amber tip on the cream cable. */
export const HAULER_TETHER_TIP_COLOR = '#FDE68A';

export const SHIP_ABILITY = {
  DASH_BOOST: 6,
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
  HARPOON_PULL: 0.42,
  HARPOON_SLACK: 1.25,
  SHIELD_FRAMES: 180,
  BURST_SPREAD: 0.12,
  SHOCK_RADIUS: 200,
  SHOCK_FORCE: 3.2,
  COOLDOWN_FRAMES: {
    dart: 90,
    hauler: 180,
    warden: 150,
    skirmisher: 150,
    quake: 180,
  },
} as const;

const KITS: Record<ShipKitId, ShipKit> = {
  dart: {
    id: 'dart',
    name: 'Dart',
    abilityId: 'boostDash',
    abilityName: 'Boost dash',
    abilityHint: 'Short burst of speed',
    flavor: 'combat',
    maxHealth: SHIP.MAX_HEALTH,
    size: SHIP.SIZE,
    thrust: SHIP.THRUST,
    maxVelocity: SHIP.MAX_VELOCITY,
    turnSpeed: SHIP.TURN_SPEED,
    shotCooldown: 250,
    burstCount: 1,
  },
  hauler: {
    id: 'hauler',
    name: 'Hauler',
    abilityId: 'harpoon',
    abilityName: 'Harpoon',
    abilityHint: 'Latch and haul a nearby rock or ship',
    flavor: 'utility',
    maxHealth: 140,
    size: 38,
    thrust: 4,
    maxVelocity: 6,
    turnSpeed: 380,
    shotCooldown: 280,
    burstCount: 1,
  },
  warden: {
    id: 'warden',
    name: 'Warden',
    abilityId: 'shieldFocus',
    abilityName: 'Shield',
    abilityHint: 'Absorb hits for a moment',
    flavor: 'combat',
    maxHealth: 120,
    size: 32,
    thrust: SHIP.THRUST,
    maxVelocity: 7,
    turnSpeed: SHIP.TURN_SPEED,
    shotCooldown: 260,
    burstCount: 1,
  },
  skirmisher: {
    id: 'skirmisher',
    name: 'Skirmisher',
    abilityId: 'burstFire',
    abilityName: 'Burst fire',
    abilityHint: 'Three-shot volley',
    flavor: 'combat',
    maxHealth: 80,
    size: 28,
    thrust: 5.4,
    maxVelocity: 8.5,
    turnSpeed: 540,
    shotCooldown: 200,
    burstCount: 3,
  },
  quake: {
    id: 'quake',
    name: 'Quake',
    abilityId: 'shockPulse',
    abilityName: 'Shock pulse',
    abilityHint: 'Knock nearby rocks and ships',
    flavor: 'geo',
    maxHealth: 110,
    size: 34,
    thrust: SHIP.THRUST,
    maxVelocity: SHIP.MAX_VELOCITY,
    turnSpeed: SHIP.TURN_SPEED,
    shotCooldown: 270,
    burstCount: 1,
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

export interface KitStatTarget {
  kitId: ShipKitId;
  maxHealth: number;
  health: number;
}

export interface KitShipTarget extends KitStatTarget {
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
