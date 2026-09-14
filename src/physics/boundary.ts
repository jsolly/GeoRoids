import { WORLD } from '../../shared/world';

export interface CircleBoundary {
  cx: number;
  cy: number;
  radius: number;
}

export function getGameBoundary(): CircleBoundary {
  return {
    cx: 0,
    cy: 0,
    radius: WORLD.radius,
  };
}
