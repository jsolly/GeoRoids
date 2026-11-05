import { GAME, SHIP } from '../../../shared/constants/gameplay';
import { TERRAIN } from '../../../shared/terrainConfig';
import { terrainCruiseVelocity } from '../../../shared/terrainTravel';
import type { Ship } from './Ship';

/** Cruise follows the nose with a bidirectional bonus for following contours. */
export function advanceCruiseVelocity(
  ship: Pick<Ship, 'position' | 'velocity' | 'angle'>,
  speedLimit: number
): void {
  const speed = Math.hypot(ship.velocity.x, ship.velocity.y);
  const acceleration = SHIP.THRUST / GAME.FPS;
  const target = terrainCruiseVelocity(ship.position, ship.angle, speedLimit);
  const targetSpeed = Math.hypot(target.x, target.y);
  const propelledSpeed =
    speed > targetSpeed
      ? Math.max(
          targetSpeed,
          speed -
            (speedLimit * TERRAIN.CONTOUR_SPEED_BONUS) /
              (GAME.FPS * TERRAIN.CONTOUR_RELEASE_SECONDS)
        )
      : Math.min(targetSpeed, speed + acceleration * (targetSpeed / speedLimit));
  const scale = targetSpeed > 0 ? propelledSpeed / targetSpeed : 0;
  ship.velocity = { x: target.x * scale, y: target.y * scale };
}

/** Actual terrain speed, excluding collision impulses. */
export function contourSpeedStrength(
  ship: Pick<Ship, 'velocity' | 'knockbackVelocityLimit'>
): number {
  const baseline = SHIP.MAX_VELOCITY;
  if (ship.knockbackVelocityLimit > baseline) {
    return 0;
  }
  return Math.max(
    0,
    Math.min(
      1,
      (Math.hypot(ship.velocity.x, ship.velocity.y) / baseline - 1) / TERRAIN.CONTOUR_SPEED_BONUS
    )
  );
}
