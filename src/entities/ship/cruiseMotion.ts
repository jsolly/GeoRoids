import { thrustScaleFromMass } from '../../../shared/shipGrowth';
import { GAME } from '../../constants';
import { terrainCruiseVelocity } from '../../physics/terrain/terrainTravel';
import type { Ship } from './Ship';

/** Cruise follows the nose with a bidirectional bonus for following contours. */
export function advanceCruiseVelocity(
  ship: Pick<Ship, 'position' | 'velocity' | 'angle' | 'mass' | 'thrust'>,
  speedLimit: number,
  thrustBoost = 1
): void {
  const speed = Math.hypot(ship.velocity.x, ship.velocity.y);
  const acceleration = (ship.thrust * thrustBoost * thrustScaleFromMass(ship.mass)) / GAME.FPS;
  const target = terrainCruiseVelocity(ship.position, ship.angle, speedLimit);
  const targetSpeed = Math.hypot(target.x, target.y);
  const propelledSpeed = Math.min(targetSpeed, speed + acceleration * (targetSpeed / speedLimit));
  const scale = targetSpeed > 0 ? propelledSpeed / targetSpeed : 0;
  ship.velocity = { x: target.x * scale, y: target.y * scale };
}
