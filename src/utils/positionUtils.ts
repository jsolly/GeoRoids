import type { Position } from '../../shared-types';
import { SHIP } from '../constants';
import { getGameBoundary } from '../physics/boundary';

/**
 * Generates a random position near a specific point, ensuring it's within the game boundary
 * @param center The center point to generate positions near
 * @param maxDistance Maximum distance from the center point
 * @returns A random position near the center point, guaranteed to be inside the boundary
 */
export function getRandomPositionNearPoint(center: Position, maxDistance: number = 200): Position {
  const boundary = getGameBoundary();
  const shipRadius = SHIP.SIZE / 2;

  // Generate a random angle and distance from the center
  const angle = Math.random() * 2 * Math.PI;
  const distance = Math.random() * maxDistance;

  // Calculate the new position
  let newX = center.x + distance * Math.cos(angle);
  let newY = center.y + distance * Math.sin(angle);

  // Ensure the position is within the boundary
  const boundaryRadius = boundary.radius - shipRadius;
  const distanceFromCenter = Math.sqrt((newX - boundary.cx) ** 2 + (newY - boundary.cy) ** 2);

  if (distanceFromCenter > boundaryRadius) {
    // If outside boundary, clamp to boundary edge
    const scale = boundaryRadius / distanceFromCenter;
    newX = boundary.cx + (newX - boundary.cx) * scale;
    newY = boundary.cy + (newY - boundary.cy) * scale;
  }

  return { x: newX, y: newY };
}

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
