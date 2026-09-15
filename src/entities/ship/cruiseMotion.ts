import { cruiseVelocity } from '../../../shared/shipFlight';
import { thrustScaleFromMass } from '../../../shared/shipGrowth';
import { GAME } from '../../constants';
import { applySharedShipSlope } from '../../physics/terrain/applyShipSlope';
import type { Ship } from './Ship';

/** Steering redirects momentum; automatic thrust and the full slope force then act on it. */
export function advanceCruiseVelocity(
  ship: Pick<Ship, 'position' | 'velocity' | 'angle' | 'mass' | 'thrust'>,
  speedLimit: number,
  thrustBoost = 1
): void {
  const speed = Math.hypot(ship.velocity.x, ship.velocity.y);
  const acceleration = (ship.thrust * thrustBoost * thrustScaleFromMass(ship.mass)) / GAME.FPS;
  const propelledSpeed = Math.min(speedLimit, speed + acceleration);
  ship.velocity = cruiseVelocity(ship.angle, propelledSpeed);
  applySharedShipSlope(ship.velocity, ship.position);
  const afterSlope = Math.hypot(ship.velocity.x, ship.velocity.y);
  if (afterSlope > speedLimit) {
    ship.velocity.x *= speedLimit / afterSlope;
    ship.velocity.y *= speedLimit / afterSlope;
  }
}
