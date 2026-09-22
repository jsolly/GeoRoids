import type { Position } from '../shared-types';

/** Standing inside this radius of the origin can open the Town Square store. */
export const TOWN_STORE_RADIUS = 400;

/** Each street furnace a pilot built adds this fraction to that pilot's delivery points. */
export const TOWN_YIELD_PER_MODULE = 0.1;

/** Score spent at Town Square for one extra life. */
export const EXTRA_LIFE_COST = 1_000;

/** Lives the store will sell up to, including the three a flight starts with. */
export const MAX_LIVES = 6;

const SHIP_PAINTS = [
  { id: 'ember', name: 'Ember', color: '#F97316', cost: 600 },
  { id: 'violet', name: 'Violet', color: '#C084FC', cost: 1_200 },
  { id: 'gold', name: 'Gold', color: '#FBBF24', cost: 2_400 },
  { id: 'ivory', name: 'Ivory', color: '#F8FAFC', cost: 4_800 },
] as const;

export const TOWN_STORE_ISSUE = {
  AWAY: 'Fly to Town Square to shop',
  WORN: 'You already wear this paint',
  CLOSED: 'The store is closed',
  FULL: `You already hold ${MAX_LIVES} lives`,
} as const;

const PAINT_BY_ID = new Map(SHIP_PAINTS.map((paint) => [paint.id, paint]));
const PAINT_COLORS = new Set<string>(SHIP_PAINTS.map((paint) => paint.color));

export function shipPaintById(id: string): (typeof SHIP_PAINTS)[number] | undefined {
  return PAINT_BY_ID.get(id as (typeof SHIP_PAINTS)[number]['id']);
}

/** True when this hex is a hull color sold at Town Square. */
export function purchasedHullColor(color: string): boolean {
  return PAINT_COLORS.has(color);
}

export function insideTownStore(position: Position): boolean {
  return Math.hypot(position.x, position.y) <= TOWN_STORE_RADIUS;
}

/** Personal furnace payout after streets this pilot built. */
export function townDeliveryPoints(base: number, modulesBuilt: number): number {
  const built = Math.max(modulesBuilt, 0);
  return Math.round(base * (1 + TOWN_YIELD_PER_MODULE * built));
}

export function townDeliveryBonusPercent(modulesBuilt: number): number {
  const built = Math.max(modulesBuilt, 0);
  return Math.round(TOWN_YIELD_PER_MODULE * built * 100);
}
