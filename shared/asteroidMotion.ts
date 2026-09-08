import type { AsteroidData, AsteroidMotionInput, Position, Velocity } from '../shared-types';
import { GAME } from '../src/constants';
import { findNearestAsteroidImpact } from './asteroidReflection';

/** Velocities and angular velocities use the existing world-units/frame convention. */
export const ASTEROID_MOTION = {
  maxAngularVelocity: 0.22,
  maxLinearVelocity: 18,
  maxRockSize: 500,
  maxFramesPerStep: 6,
  maxSessions: 128,
  latchRange: 280,
  payloadRange: 400,
  latchLifetimeMs: 15_000,
  reconnectGraceMs: 2000,
  handoffTimeoutMs: 2000,
  inputTimeoutMs: 250,
  /** Lead credit covers 150ms transport jitter once, not once per packet. */
  poseLeadFrames: 9,
  poseTolerance: 2,
  fuelPerFrame: 0.12,
  releaseDrag: 0.97,
  couplingPerFrame: 0.08,
} as const;

export function finiteMotionVector(vector: Position): boolean {
  return (
    Number.isFinite(vector.x) &&
    Number.isFinite(vector.y) &&
    Math.abs(vector.x) <= 10_000_000 &&
    Math.abs(vector.y) <= 10_000_000
  );
}

export function capMotionVelocity(velocity: Velocity, maximum: number): Velocity {
  if (!finiteMotionVector(velocity) || !Number.isFinite(maximum) || maximum < 0) {
    throw new RangeError('Motion velocity and cap must be finite');
  }
  const magnitude = Math.hypot(velocity.x, velocity.y);
  const scale = magnitude > maximum && magnitude > 0 ? maximum / magnitude : 1;
  return { x: velocity.x * scale, y: velocity.y * scale };
}

export function boundedAngularVelocity(omega: number): number {
  if (!Number.isFinite(omega)) {
    throw new RangeError('Angular velocity must be finite');
  }
  return Math.max(
    -ASTEROID_MOTION.maxAngularVelocity,
    Math.min(ASTEROID_MOTION.maxAngularVelocity, omega)
  );
}

export function asteroidMass(rock: Pick<AsteroidData, 'size' | 'material'>): number {
  if (!Number.isFinite(rock.size) || rock.size <= 0 || rock.size > ASTEROID_MOTION.maxRockSize) {
    throw new RangeError('Invalid physical asteroid radius');
  }
  const density = rock.material === 'metal' ? 2 : rock.material === 'ice' ? 0.7 : 1.2;
  return Math.max(1, (density * rock.size * rock.size) / 400);
}

export function asteroidInertia(rock: Pick<AsteroidData, 'size' | 'material'>): number {
  return 0.5 * asteroidMass(rock) * rock.size * rock.size;
}

export function tangentVelocity(
  centerVelocity: Velocity,
  offset: Position,
  omega: number
): Velocity {
  if (
    !finiteMotionVector(centerVelocity) ||
    !finiteMotionVector(offset) ||
    !Number.isFinite(omega)
  ) {
    throw new RangeError('Invalid tangential motion');
  }
  return { x: centerVelocity.x - omega * offset.y, y: centerVelocity.y + omega * offset.x };
}

/** Finds the actual polygon surface facing the ship, not its nominal circle. */
export function asteroidSurfaceLatch(
  rock: AsteroidData,
  shipPosition: Position
): {
  angle: number;
  radius: number;
  point: Position;
} {
  asteroidMass(rock);
  if (!finiteMotionVector(shipPosition)) {
    throw new RangeError('Invalid latch position');
  }
  const dx = shipPosition.x - rock.position.x;
  const dy = shipPosition.y - rock.position.y;
  const angle = Math.hypot(dx, dy) > 1e-6 ? Math.atan2(dy, dx) : rock.rotation;
  const reach = rock.size * 5;
  const hit = findNearestAsteroidImpact(
    rock.position,
    {
      x: rock.position.x + Math.cos(angle) * reach,
      y: rock.position.y + Math.sin(angle) * reach,
    },
    [rock]
  );
  if (!hit || hit.distance <= 1e-6) {
    throw new RangeError('Asteroid has no latchable surface');
  }
  return { angle: angle - rock.rotation, radius: hit.distance, point: hit.point };
}

/** Dissipative coupling conserves angular momentum including the payload's orbit.
 * Supply the primary's effective inertia including its latched pilot. The pair's
 * barycenter velocity stays unchanged; callers enforce their fixed separation.
 */
export function coupleAsteroidMomentum(
  primary: AsteroidData,
  payload: AsteroidData,
  effectivePrimaryInertia: number,
  frames: number
): void {
  if (
    !Number.isFinite(frames) ||
    frames < 0 ||
    frames > ASTEROID_MOTION.maxFramesPerStep ||
    !Number.isFinite(effectivePrimaryInertia) ||
    effectivePrimaryInertia <= 0
  ) {
    throw new RangeError('Invalid coupling step');
  }
  const m1 = asteroidMass(primary);
  const m2 = asteroidMass(payload);
  const offset = {
    x: payload.position.x - primary.position.x,
    y: payload.position.y - primary.position.y,
  };
  const radiusSquared = offset.x * offset.x + offset.y * offset.y;
  if (!Number.isFinite(radiusSquared) || radiusSquared <= 1e-6) {
    throw new RangeError('Coincident payload anchors');
  }
  const reducedMass = (m1 * m2) / (m1 + m2);
  const orbitInertia = reducedMass * radiusSquared;
  const payloadInertia = asteroidInertia(payload);
  const relative = {
    x: payload.velocity.x - primary.velocity.x,
    y: payload.velocity.y - primary.velocity.y,
  };
  const orbitOmega = (offset.x * relative.y - offset.y * relative.x) / radiusSquared;
  const common =
    (effectivePrimaryInertia * primary.angularVelocity +
      payloadInertia * payload.angularVelocity +
      orbitInertia * orbitOmega) /
    (effectivePrimaryInertia + payloadInertia + orbitInertia);
  if (!Number.isFinite(common)) {
    throw new RangeError('Invalid coupled angular momentum');
  }
  const fraction = 1 - (1 - ASTEROID_MOTION.couplingPerFrame) ** frames;
  const nextOrbit = orbitOmega + (common - orbitOmega) * fraction;
  primary.angularVelocity += (common - primary.angularVelocity) * fraction;
  payload.angularVelocity += (common - payload.angularVelocity) * fraction;
  const centerVelocity = {
    x: (m1 * primary.velocity.x + m2 * payload.velocity.x) / (m1 + m2),
    y: (m1 * primary.velocity.y + m2 * payload.velocity.y) / (m1 + m2),
  };
  const tangent = { x: -nextOrbit * offset.y, y: nextOrbit * offset.x };
  primary.velocity = {
    x: centerVelocity.x - (m2 / (m1 + m2)) * tangent.x,
    y: centerVelocity.y - (m2 / (m1 + m2)) * tangent.y,
  };
  payload.velocity = {
    x: centerVelocity.x + (m1 / (m1 + m2)) * tangent.x,
    y: centerVelocity.y + (m1 / (m1 + m2)) * tangent.y,
  };
  // If a safety limit binds, scale every velocity together: caps dissipate energy
  // instead of inventing an independent impulse for either participant.
  const ratio = Math.max(
    1,
    Math.abs(primary.angularVelocity) / ASTEROID_MOTION.maxAngularVelocity,
    Math.abs(payload.angularVelocity) / ASTEROID_MOTION.maxAngularVelocity,
    Math.hypot(primary.velocity.x, primary.velocity.y) / ASTEROID_MOTION.maxLinearVelocity,
    Math.hypot(payload.velocity.x, payload.velocity.y) / ASTEROID_MOTION.maxLinearVelocity
  );
  primary.angularVelocity /= ratio;
  payload.angularVelocity /= ratio;
  primary.velocity.x /= ratio;
  primary.velocity.y /= ratio;
  payload.velocity.x /= ratio;
  payload.velocity.y /= ratio;
}

export function turnMotionAngle(
  angle: number,
  input: Pick<AsteroidMotionInput, 'turn' | 'aimAngle'>,
  turnDegreesPerSecond: number,
  frames: number
): number {
  if (
    !Number.isFinite(angle) ||
    !Number.isFinite(input.aimAngle) ||
    ![-1, 0, 1].includes(input.turn) ||
    !Number.isFinite(turnDegreesPerSecond) ||
    turnDegreesPerSecond < 0 ||
    !Number.isFinite(frames) ||
    frames < 0 ||
    frames > ASTEROID_MOTION.maxFramesPerStep
  ) {
    throw new RangeError('Invalid bounded ship turn');
  }
  const limit = ((turnDegreesPerSecond * Math.PI) / 180 / GAME.FPS) * frames;
  const delta = Math.atan2(Math.sin(input.aimAngle - angle), Math.cos(input.aimAngle - angle));
  const next =
    angle + (input.turn !== 0 ? input.turn * limit : Math.max(-limit, Math.min(limit, delta)));
  return Math.atan2(Math.sin(next), Math.cos(next));
}

/** Shared release/prediction step; resource spending remains server-owned. */
export function stepReleasedMotion(
  body: { position: Position; velocity: Velocity; angle: number },
  input: Pick<AsteroidMotionInput, 'thrust' | 'turn' | 'aimAngle'>,
  thrustPerFrame: number,
  turnDegreesPerSecond: number,
  frames: number
): void {
  if (
    !Number.isFinite(frames) ||
    frames < 0 ||
    frames > 1 ||
    !Number.isFinite(thrustPerFrame) ||
    thrustPerFrame < 0
  ) {
    throw new RangeError('Released motion requires a bounded substep');
  }
  if (
    !finiteMotionVector(body.position) ||
    !finiteMotionVector(body.velocity) ||
    typeof input.thrust !== 'boolean'
  ) {
    throw new RangeError('Invalid released motion state');
  }
  body.angle = turnMotionAngle(body.angle, input, turnDegreesPerSecond, frames);
  const drag = ASTEROID_MOTION.releaseDrag ** frames;
  body.velocity = capMotionVelocity(
    {
      x:
        body.velocity.x * drag +
        (input.thrust ? Math.cos(body.angle) * thrustPerFrame * frames : 0),
      y:
        body.velocity.y * drag -
        (input.thrust ? Math.sin(body.angle) * thrustPerFrame * frames : 0),
    },
    ASTEROID_MOTION.maxLinearVelocity
  );
  body.position.x += body.velocity.x * frames;
  body.position.y += body.velocity.y * frames;
}
