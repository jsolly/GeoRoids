import type { Position } from '../../shared-types';
import { SHIP } from '../constants';
import { getGameBoundary } from '../physics/boundary';

/**
 * Generates a random position near the game boundary, ensuring it's within the boundary
 * @param minDistanceFromCenter Minimum distance from center (default: 60% of boundary radius)
 * @returns A random position near the boundary, guaranteed to be inside the boundary
 */
export function getRandomPositionNearBoundary(minDistanceFromCenter: number = 0.6): Position {
  const boundary = getGameBoundary();
  const shipRadius = SHIP.SIZE / 2;
  const boundaryRadius = boundary.radius - shipRadius;

  // Calculate the minimum radius for positioning near boundary
  const minRadius = boundaryRadius * minDistanceFromCenter;
  const maxRadius = boundaryRadius;

  // Generate a random angle and distance within the boundary ring
  const angle = Math.random() * 2 * Math.PI;
  const distance = minRadius + Math.random() * (maxRadius - minRadius);

  // Calculate the position
  const x = boundary.cx + distance * Math.cos(angle);
  const y = boundary.cy + distance * Math.sin(angle);

  return { x, y };
}
