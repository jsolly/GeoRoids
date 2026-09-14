import type { Velocity } from '../shared-types';
import { SHIP } from '../src/constants';
import { maxVelocityFromMass } from './shipGrowth';

export function cruiseSpeed(mass: number, kitMaxVelocity: number): number {
  return (kitMaxVelocity * maxVelocityFromMass(mass)) / SHIP.MAX_VELOCITY;
}

export function cruiseVelocity(angle: number, speed: number): Velocity {
  return { x: Math.cos(angle) * speed, y: -Math.sin(angle) * speed };
}
