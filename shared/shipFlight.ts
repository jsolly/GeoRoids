import type { Velocity } from '../shared-types';

export function cruiseVelocity(angle: number, speed: number): Velocity {
  return { x: Math.cos(angle) * speed, y: -Math.sin(angle) * speed };
}
