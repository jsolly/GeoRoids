import type { ShipKitId, Velocity } from '../shared-types';
import { SHIP } from '../src/constants';
import { SHIP_ABILITY } from '../src/entities/ship/shipKits';
import { maxVelocityFromMass } from './shipGrowth';

export function cruiseSpeed(mass: number, kitMaxVelocity: number): number {
  return (kitMaxVelocity * maxVelocityFromMass(mass)) / SHIP.MAX_VELOCITY;
}

export function dashSpeedBonus(kitId: ShipKitId | undefined, activeFrames: number): number {
  return kitId === 'dart' && activeFrames > 0 ? SHIP_ABILITY.DASH_BOOST : 0;
}

export function cruiseVelocity(angle: number, speed: number): Velocity {
  return { x: Math.cos(angle) * speed, y: -Math.sin(angle) * speed };
}
