import type { AsteroidBoost, Position, Velocity } from '../shared-types';
import { asteroidCrewNeeded } from './asteroidScale';
import type { FurnaceField } from './furnaceField';
import { nearestFurnace } from './furnaces';

export function boostOwnerIds(boost: AsteroidBoost | null | undefined): string[] {
  if (!boost) {
    return [];
  }
  if (boost.couplings && boost.couplings.length > 0) {
    return [...new Set(boost.couplings)];
  }
  return [boost.ownerId];
}

function packBoost(
  phase: AsteroidBoost['phase'],
  ownerId: string,
  angle: number,
  owners: readonly string[]
): AsteroidBoost {
  return owners.length > 1
    ? { phase, ownerId, angle, couplings: [...owners] }
    : { phase, ownerId, angle };
}

/** Armed couplings gather a crew; a burning colossal accepts late couplings. */
export function addBoostOwner(boost: AsteroidBoost, ownerId: string): AsteroidBoost {
  const owners = boostOwnerIds(boost);
  if (!owners.includes(ownerId)) {
    owners.push(ownerId);
  }
  return packBoost(boost.phase, boost.ownerId, boost.angle, owners);
}

export function removeBoostOwner(boost: AsteroidBoost, ownerId: string): AsteroidBoost | null {
  if (boost.phase !== 'armed') {
    return boost;
  }
  const owners = boostOwnerIds(boost).filter((id) => id !== ownerId);
  if (owners.length === 0) {
    return null;
  }
  const primary = owners.includes(boost.ownerId) ? boost.ownerId : (owners[0] ?? ownerId);
  return packBoost('armed', primary, boost.angle, owners);
}

export function igniteBoost(boost: AsteroidBoost, angle: number): AsteroidBoost {
  return packBoost('burning', boost.ownerId, angle, boostOwnerIds(boost));
}

/** Velocity uses world units per fixed 60 Hz simulation tick. */
export const ASTEROID_BOOST = {
  acceleration: 0.025,
  maxSpeed: 2.5,
  /** An undercrewed colossal crawls; a full crew restores normal speed. */
  undercrewedFactor: 0.2,
} as const;

/** Full thrust needs the size's crew; fewer couplings crawl. */
function boostThrustFactor(boost: AsteroidBoost, size: number) {
  return boostOwnerIds(boost).length >= asteroidCrewNeeded(size)
    ? 1
    : ASTEROID_BOOST.undercrewedFactor;
}

export function furnaceHeading(position: Position, furnaces?: FurnaceField): number {
  const target = (furnaces?.nearest(position) ?? nearestFurnace(position)).position;
  return Math.atan2(position.y - target.y, target.x - position.x);
}

/** Shared guidance keeps authoritative motion and client prediction in agreement. */
export function tickAsteroidBoost(
  body: {
    boost?: AsteroidBoost | null;
    position: Position;
    velocity: Velocity;
  },
  size: number,
  furnaces?: FurnaceField
): void {
  const boost = body.boost;
  if (!boost) {
    return;
  }
  const target = (furnaces?.nearest(body.position) ?? nearestFurnace(body.position)).position;
  const dx = target.x - body.position.x;
  const dy = target.y - body.position.y;
  const distance = Math.hypot(dx, dy);
  boost.angle = Math.atan2(body.position.y - target.y, dx);
  if (boost.phase !== 'burning') {
    return;
  }
  // Seek a velocity, rather than adding radial thrust forever: this cancels
  // sideways momentum from impacts instead of orbiting the intake indefinitely.
  const thrust = boostThrustFactor(boost, size);
  const maxSpeed = ASTEROID_BOOST.maxSpeed * thrust;
  const scale = distance > 0 ? Math.min(maxSpeed / distance, 1 / 60) : 0;
  const changeX = dx * scale - body.velocity.x;
  const changeY = dy * scale - body.velocity.y;
  const change = Math.hypot(changeX, changeY);
  const fraction = change > 0 ? Math.min(1, (ASTEROID_BOOST.acceleration * thrust) / change) : 0;
  body.velocity.x += changeX * fraction;
  body.velocity.y += changeY * fraction;
  const speed = Math.hypot(body.velocity.x, body.velocity.y);
  if (speed > maxSpeed) {
    body.velocity.x *= maxSpeed / speed;
    body.velocity.y *= maxSpeed / speed;
  }
}
