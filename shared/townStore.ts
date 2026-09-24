import type { Position } from '../shared-types';

/** Standing inside this radius of the origin can open the Town Square store. */
export const TOWN_STORE_RADIUS = 400;

export const TOWN_STORE_ISSUE = {
  AWAY: 'Fly to Town Square to shop',
  CLOSED: 'The store is closed',
} as const;

const PAINT_COLORS = new Set(['#F97316', '#C084FC', '#FBBF24', '#F8FAFC']);

/** Retain hull colors owned before the store became a placeholder catalog. */
export function purchasedHullColor(color: string): boolean {
  return PAINT_COLORS.has(color);
}

export function insideTownStore(position: Position): boolean {
  return Math.hypot(position.x, position.y) <= TOWN_STORE_RADIUS;
}

/** Purchase receipts only. These offers intentionally grant no equipment or stats. */
export const STORE_OFFERS = [
  { id: 'placeholder-1', name: 'Placeholder A', level: 1, cost: 100 },
  { id: 'placeholder-2', name: 'Placeholder B', level: 2, cost: 250 },
  { id: 'placeholder-3', name: 'Placeholder C', level: 3, cost: 500 },
  { id: 'placeholder-4', name: 'Placeholder D', level: 4, cost: 1000 },
] as const;
export function storeOffer(id: string): (typeof STORE_OFFERS)[number] | undefined {
  return STORE_OFFERS.find((offer) => offer.id === id);
}
