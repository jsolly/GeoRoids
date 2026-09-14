import type { Position, Velocity } from '../../../shared-types';
import { applySlopeForce } from './slopeForce';
import { getTerrainField } from './terrainSession';

/**
 * Single entry used by the local player ship so it feels the same slope field.
 */
export function applySharedShipSlope(velocity: Velocity, position: Position): void {
  applySlopeForce(velocity, position, getTerrainField());
}
