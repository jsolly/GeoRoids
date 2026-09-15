import type { Velocity } from '../shared-types';
import { SHIP } from '../src/constants';
import { maxVelocityFromMass } from './shipGrowth';

export function cruiseSpeed(mass: number, kitMaxVelocity: number, boostMultiplier = 1): number {
  return (kitMaxVelocity * maxVelocityFromMass(mass) * boostMultiplier) / SHIP.MAX_VELOCITY;
}

export function cruiseVelocity(angle: number, speed: number): Velocity {
  return { x: Math.cos(angle) * speed, y: -Math.sin(angle) * speed };
}
