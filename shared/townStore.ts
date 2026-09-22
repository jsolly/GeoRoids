import type { Position } from '../shared-types';

/** Standing inside this radius of the origin can open the Town Square store. */
export const TOWN_STORE_RADIUS = 400;

/** Score spent at Town Square for one extra life. */
export const EXTRA_LIFE_COST = 1_000;

/** Lives the store will sell up to, including the three a flight starts with. */
export const MAX_LIVES = 6;

export const TOWN_STORE_ISSUE = {
  AWAY: 'Fly to Town Square to shop',
  CLOSED: 'The store is closed',
  FULL: `You already hold ${MAX_LIVES} lives`,
} as const;

export function insideTownStore(position: Position): boolean {
  return Math.hypot(position.x, position.y) <= TOWN_STORE_RADIUS;
}
