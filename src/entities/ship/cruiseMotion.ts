import { cruiseSpeed } from '../../../shared/shipFlight';
import { thrustScaleFromMass } from '../../../shared/shipGrowth';
import { GAME } from '../../constants';
import { TERRAIN } from '../../physics/terrain/terrainConfig';
import { terrainCruiseVelocity } from '../../physics/terrain/terrainTravel';
import type { Ship } from './Ship';

/** Cruise follows the nose with a bidirectional bonus for following contours. */
export function advanceCruiseVelocity(
  ship: Pick<Ship, 'position' | 'velocity' | 'angle' | 'mass' | 'thrust'>,
  speedLimit: number
): void {
  const speed = Math.hypot(ship.velocity.x, ship.velocity.y);
  const acceleration = (ship.thrust * thrustScaleFromMass(ship.mass)) / GAME.FPS;
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
  ship: Pick<Ship, 'mass' | 'maxVelocity' | 'velocity' | 'knockbackVelocityLimit'>
): number {
  const baseline = cruiseSpeed(ship.mass, ship.maxVelocity);
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
