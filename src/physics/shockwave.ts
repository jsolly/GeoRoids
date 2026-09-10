import type { Position, Velocity } from '../../shared-types';
import { GAME, SHOCKWAVE } from '../constants';

export type ShockwaveWaveId = 'fast' | 'heavy';

export type ShockwaveWaveSpec = {
  id: ShockwaveWaveId;
  delayFrames: number;
  durationFrames: number;
  radius: number;
  impulse: number;
  strokeWidth: number;
};

type ShockwaveBody = {
  position: Position;
  velocity: Velocity;
  size: number;
};

export const SHOCKWAVE_WAVES: readonly ShockwaveWaveSpec[] = [
  { id: 'fast', ...SHOCKWAVE.FAST },
  { id: 'heavy', ...SHOCKWAVE.HEAVY },
];

export function framesToMs(frames: number): number {
  return (frames * 1000) / GAME.FPS;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Inverse-size scale. A medium roid is 1.0; crumbs approach MAX_SIZE_SCALE
 * and leftover giants sit near MIN_SIZE_SCALE.
 */
export function sizeImpulseScale(size: number): number {
  const safeSize = Math.max(SHOCKWAVE.MIN_SIZE, size);
  const ratio = SHOCKWAVE.REFERENCE_SIZE / safeSize;
  return clamp(
    ratio ** SHOCKWAVE.SIZE_EXPONENT,
    SHOCKWAVE.MIN_SIZE_SCALE,
    SHOCKWAVE.MAX_SIZE_SCALE
  );
}

export function distanceFalloff(distance: number, radius: number): number {
  if (!(radius > 0) || distance > radius) {
    return 0;
  }
  if (distance <= 0) {
    return 1;
  }
  return 1 - distance / radius;
}

export function computeRadialImpulse(
  origin: Position,
  target: Position,
  size: number,
  wave: Pick<ShockwaveWaveSpec, 'radius' | 'impulse'>,
  fallbackVelocity?: Velocity
): Velocity | null {
  const dx = target.x - origin.x;
  const dy = target.y - origin.y;
  const distance = Math.hypot(dx, dy);
  const falloff = distanceFalloff(distance, wave.radius);
  if (falloff <= 0) {
    return null;
  }

  let nx: number;
  let ny: number;
  if (distance > 0) {
    nx = dx / distance;
    ny = dy / distance;
  } else {
    const speed = fallbackVelocity ? Math.hypot(fallbackVelocity.x, fallbackVelocity.y) : 0;
    if (speed > 0 && fallbackVelocity) {
      nx = fallbackVelocity.x / speed;
      ny = fallbackVelocity.y / speed;
    } else {
      nx = 1;
      ny = 0;
    }
  }

  const magnitude = wave.impulse * falloff * sizeImpulseScale(size);
  return { x: nx * magnitude, y: ny * magnitude };
}

function applyImpulseToVelocity(velocity: Velocity, impulse: Velocity): Velocity {
  return { x: velocity.x + impulse.x, y: velocity.y + impulse.y };
}

export function applyShockwaveToBody(
  body: ShockwaveBody,
  origin: Position,
  wave: Pick<ShockwaveWaveSpec, 'radius' | 'impulse'>
): Velocity | null {
  const impulse = computeRadialImpulse(origin, body.position, body.size, wave, body.velocity);
  if (!impulse) {
    return null;
  }
  return applyImpulseToVelocity(body.velocity, impulse);
}

export function waveVisualProgress(ageMs: number, wave: ShockwaveWaveSpec): number | null {
  const elapsed = ageMs - framesToMs(wave.delayFrames);
  const durationMs = framesToMs(wave.durationFrames);
  if (elapsed < 0 || elapsed > durationMs || durationMs <= 0) {
    return null;
  }
  return elapsed / durationMs;
}

export function easedRingRadius(progress: number, maxRadius: number): number {
  const eased = 1 - (1 - clamp(progress, 0, 1)) ** 3;
  return maxRadius * eased;
}

export function ringAlpha(progress: number, peak: number): number {
  return peak * (1 - clamp(progress, 0, 1)) ** 1.15;
}

export function shockwaveLifetimeMs(): number {
  let max = 0;
  for (const wave of SHOCKWAVE_WAVES) {
    max = Math.max(max, framesToMs(wave.delayFrames + wave.durationFrames));
  }
  return max + 80;
}
