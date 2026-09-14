import type { Position, Velocity } from '../../../shared-types';
import { GAME } from '../../constants';
import type { Heightfield } from './heightfield';
import { sampleGradient } from './heightfield';
import { TERRAIN } from './terrainConfig';

/**
 * Apply the same downslope acceleration + uphill drag to any ship velocity.
 */
export function applySlopeForce(
  velocity: Velocity,
  position: Position,
  field: Heightfield,
  dtSeconds: number = 1 / GAME.FPS
): void {
  const gradient = sampleGradient(field, position.x, position.y);
  const steepness = Math.hypot(gradient.x, gradient.y);
  if (steepness < 1e-6) {
    return;
  }

  const nx = gradient.x / steepness;
  const ny = gradient.y / steepness;
  const t = Math.min(1, steepness / TERRAIN.REF_GRADIENT);
  const accel = TERRAIN.SLOPE_ACCEL * t * dtSeconds;

  velocity.x -= nx * accel;
  velocity.y -= ny * accel;

  const uphill = velocity.x * nx + velocity.y * ny;
  if (uphill > 0) {
    const drag = TERRAIN.UPHILL_DRAG * t * uphill * dtSeconds;
    velocity.x -= nx * drag;
    velocity.y -= ny * drag;
  }
}
