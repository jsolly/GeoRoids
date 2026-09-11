import type { Position, Velocity } from '../../../shared-types';
import { GAME, LASER } from '../../constants';

/** Number of projectiles in the Skirmisher's full outward E ring. */
export const SKIRMISHER_RING_COUNT = 12;

interface SkirmisherRingShot {
  angle: number;
  position: Position;
  velocity: Velocity;
}

/** Build the same evenly spaced ring for local prediction and server authority. */
export function createSkirmisherRingShots(
  position: Position,
  angle: number,
  radius: number,
  carry: Velocity
): SkirmisherRingShot[] {
  const noseRadius = (4 / 3) * radius;
  return Array.from({ length: SKIRMISHER_RING_COUNT }, (_, index) => {
    const shotAngle = angle + (index * Math.PI * 2) / SKIRMISHER_RING_COUNT;
    return {
      angle: shotAngle,
      position: {
        x: position.x + Math.cos(shotAngle) * noseRadius,
        y: position.y - Math.sin(shotAngle) * noseRadius,
      },
      velocity: {
        x: carry.x + (Math.cos(shotAngle) * LASER.SPEED) / GAME.FPS,
        y: carry.y - (Math.sin(shotAngle) * LASER.SPEED) / GAME.FPS,
      },
    };
  });
}
