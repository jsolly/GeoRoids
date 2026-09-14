import type { Position } from '../../shared-types';
import { DEBUG, SPAWN } from '../constants';
import { getAsteroidFieldRadius } from '../physics/asteroidMotion';
import { getGameBoundary } from '../physics/boundary';
import { getRandomPositionNearBoundary, getRandomPositionNearPoint } from './positionUtils';

const WORLD_ORIGIN: Position = { x: 0, y: 0 };

/**
 * Shared player/bot spawn. Local, remote, and bot ships use this — no
 * factory-specific forks. Debug "near center" is world origin, not canvas
 * (400, 300), so a late-join camera does not sit 500px off the belt.
 */
export function resolveSpawnPosition(explicit?: Position): Position {
  if (explicit) {
    return explicit;
  }
  if (DEBUG.PLACE_PLAYERS_NEAR_BOUNDARY) {
    return getRandomPositionNearBoundary();
  }
  return getRandomPositionNearPoint(WORLD_ORIGIN, SPAWN.NEAR_CENTER_RADIUS);
}

/** Local placeholder positions use the same world bounds as the server. */
export function getRandomPositionInAsteroidField(): Position {
  const { cx, cy } = getGameBoundary();
  const maxR = getAsteroidFieldRadius();
  const t = Math.random() * 2 * Math.PI;
  const r = Math.sqrt(Math.random()) * maxR;
  return { x: cx + r * Math.cos(t), y: cy + r * Math.sin(t) };
}
