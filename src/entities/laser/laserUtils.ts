import type { Velocity } from '../../../shared-types';
import { GAME, LASER } from '../../constants';
import { addVectors } from '../../utils/mathUtils';
import type { Ship } from '../ship/Ship';
import { calculateLaserStartPosition } from '../ship/shipUtils';
import { Laser } from './Laser';

export function generateLaserVelocity(shipAngle: number, shipVelocity: Velocity): Velocity {
  const baseVelocity: Velocity = {
    x: (Math.cos(shipAngle) * LASER.SPEED) / GAME.FPS,
    y: (-Math.sin(shipAngle) * LASER.SPEED) / GAME.FPS,
  };
  return addVectors(baseVelocity, shipVelocity);
}

export function createLaser(ship: Ship): Laser {
  return createLaserAtAngle(ship, ship.angle);
}

export function createLaserAtAngle(ship: Ship, angle: number): Laser {
  const laserStartPosition = calculateLaserStartPosition(ship.position, angle, ship.r);
  const laserVelocity = generateLaserVelocity(angle, ship.velocity);

  return new Laser(laserStartPosition, laserVelocity, 0, 0, false);
}
