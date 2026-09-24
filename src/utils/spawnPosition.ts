import { townSquareSpawn } from '../../shared/furnaces';
import type { Position } from '../../shared-types';
import { DEBUG } from '../constants';
import { getAsteroidFieldRadius } from '../physics/asteroidMotion';
import { getGameBoundary } from '../physics/boundary';
import { getRandomPositionNearBoundary } from './positionUtils';

/**
 * Shared player spawn. Local and remote ships use this — no factory-specific
 * forks. A fresh flight stands on the town ring. Debug "near boundary" is the
 * world edge, not a canvas corner.
 */
export function resolveSpawnPosition(explicit?: Position): Position {
  if (explicit) {
    return explicit;
  }
  if (DEBUG.PLACE_PLAYERS_NEAR_BOUNDARY) {
    return getRandomPositionNearBoundary();
  }
  return townSquareSpawn(Math.random);
}

/** Local placeholder positions use the same world bounds as the server. */
export function getRandomPositionInAsteroidField(): Position {
  const { cx, cy } = getGameBoundary();
  const maxR = getAsteroidFieldRadius();
  const t = Math.random() * 2 * Math.PI;
  const r = Math.sqrt(Math.random()) * maxR;
  return { x: cx + r * Math.cos(t), y: cy + r * Math.sin(t) };
}
