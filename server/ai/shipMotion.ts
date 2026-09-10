import { GROWTH, maxVelocityFromMass, thrustScaleFromMass } from '../../shared/shipGrowth';
import type { Position, Velocity } from '../../shared-types';
import { GAME, LASER, SHIP } from '../../src/constants';
import { containAsteroidPosition, getAsteroidFieldRadius } from '../../src/physics/asteroidMotion';
import { getGameBoundary } from '../../src/physics/boundary';
import { applySharedShipSlope } from '../../src/physics/terrain/applyShipSlope';

/** Kill-wall radius. Bots stay inside the shared belt, not a private hull. */
export const ARENA_RADIUS = getGameBoundary().radius;
/** Same play-field contain the rest of the server uses for bots. */
export const CONTAIN_RADIUS = getAsteroidFieldRadius();
/** Start steering home before the contain clamp. */
export const STEER_IN_RADIUS = Math.max(0, CONTAIN_RADIUS - 200);

interface MovableShip {
  position: Position;
  velocity: Velocity;
  angle: number;
  thrusting: boolean;
  mass?: number;
}

/**
 * One client-frame of shared ship motion (thrust, mass cap, friction, slope).
 * Bots use this so they fly the same hull as players — controller only decides
 * angle + thrusting.
 */
export function applyShipMotionFrame(ship: MovableShip): void {
  const mass = ship.mass ?? GROWTH.BASE_MASS;
  const thrustScale = thrustScaleFromMass(mass);
  const maxVelocity = maxVelocityFromMass(mass);

  if (ship.thrusting) {
    ship.velocity.x += (Math.cos(ship.angle) * SHIP.THRUST * thrustScale) / GAME.FPS;
    ship.velocity.y -= (Math.sin(ship.angle) * SHIP.THRUST * thrustScale) / GAME.FPS;
    const speed = Math.hypot(ship.velocity.x, ship.velocity.y);
    if (speed > maxVelocity) {
      const scale = maxVelocity / speed;
      ship.velocity.x *= scale;
      ship.velocity.y *= scale;
    }
  } else {
    const drag = 1 - GAME.FRICTION / GAME.FPS;
    ship.velocity.x *= drag;
    ship.velocity.y *= drag;
  }

  applySharedShipSlope(ship.velocity, ship.position);
  const afterSlope = Math.hypot(ship.velocity.x, ship.velocity.y);
  if (afterSlope > SHIP.MAX_VELOCITY) {
    const scale = SHIP.MAX_VELOCITY / afterSlope;
    ship.velocity.x *= scale;
    ship.velocity.y *= scale;
  }

  ship.position.x += ship.velocity.x;
  ship.position.y += ship.velocity.y;
}

/** Bot AI ticks at 30 Hz (every 2 client frames). */
export function applyShipMotionSteps(ship: MovableShip, steps: number): void {
  for (let i = 0; i < steps; i++) {
    applyShipMotionFrame(ship);
  }
}

/**
 * Keep a ship inside the shared belt. Bounce + face inward so wanderers
 * stay reachable instead of escaping the arena.
 */
export function containShipInArena(ship: MovableShip, containRadius = CONTAIN_RADIUS): void {
  const distFromCenter = Math.hypot(ship.position.x, ship.position.y);
  if (distFromCenter <= containRadius || distFromCenter === 0) {
    return;
  }

  const nx = ship.position.x / distFromCenter;
  const ny = ship.position.y / distFromCenter;
  const contained = containAsteroidPosition(ship.position.x, ship.position.y);
  ship.position.x = contained.x;
  ship.position.y = contained.y;

  const vDotN = ship.velocity.x * nx + ship.velocity.y * ny;
  if (vDotN > 0) {
    ship.velocity.x -= 2 * vDotN * nx;
    ship.velocity.y -= 2 * vDotN * ny;
  }

  // Forward vector is (cos a, -sin a); face back toward origin.
  ship.angle = Math.atan2(ny, -nx);
}

export function headingTo(from: Position, to: Position): number {
  return Math.atan2(-(to.y - from.y), to.x - from.x);
}

export function shortestAngleDelta(from: number, to: number): number {
  let delta = to - from;
  while (delta > Math.PI) {
    delta -= Math.PI * 2;
  }
  while (delta < -Math.PI) {
    delta += Math.PI * 2;
  }
  return delta;
}

export function turnToward(current: number, desired: number, maxTurn: number): number {
  const delta = shortestAngleDelta(current, desired);
  const clamped = Math.max(-maxTurn, Math.min(maxTurn, delta));
  return current + clamped;
}

/** Player turn rate in radians per client frame. */
export function shipTurnPerFrame(): number {
  return (SHIP.TURN_SPEED * Math.PI) / 180 / GAME.FPS;
}

/** Laser speed in pixels per client frame (same as `generateLaserVelocity`). */
export function laserSpeedPerFrame(): number {
  return LASER.SPEED / GAME.FPS;
}
