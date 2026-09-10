import type { Position, Velocity } from '../../shared-types';

// Utility functions to replace Vector operations
export function addVectors(a: Velocity, b: Velocity): Velocity {
  return { x: a.x + b.x, y: a.y + b.y };
}

export function addPositionAndVelocity(pos: Position, vel: Velocity): Position {
  return { x: pos.x + vel.x, y: pos.y + vel.y };
}

export function getVelocityMagnitude(vel: Velocity): number {
  return Math.sqrt(vel.x ** 2 + vel.y ** 2);
}

export function getDistance(pos1: Position, pos2: Position): number {
  return Math.sqrt((pos1.x - pos2.x) ** 2 + (pos1.y - pos2.y) ** 2);
}

export function createPositionFromAngle(angle: number, magnitude: number): Position {
  return {
    x: Math.cos(angle) * magnitude,
    y: -Math.sin(angle) * magnitude,
  };
}

export function addPositions(pos1: Position, pos2: Position): Position {
  return { x: pos1.x + pos2.x, y: pos1.y + pos2.y };
}
