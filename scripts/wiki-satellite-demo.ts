import { RNGService } from '../server/core/RNGService';
import { SatellitePickupManager } from '../server/core/SatellitePickupManager';
import { SATELLITE_PROFILES } from '../shared/eoSatellites';
import type { SatellitePickupData } from '../shared-types';

export interface SatelliteDemoPanel {
  pickup: SatellitePickupData;
}

/** Record the real pickup roster drifting in matching controlled conditions.
 * Differences come from each Earth-observation hull, not from hostile AI. */
export function recordSatelliteDemo(
  frameCount: number,
  ticksPerFrame: number
): SatelliteDemoPanel[][] {
  const manager = new SatellitePickupManager(new RNGService(0x507a112e));
  const roster = manager.createPickups(SATELLITE_PROFILES.length);
  if (roster.length !== SATELLITE_PROFILES.length) {
    throw new Error('Satellite demonstration requires the complete live roster');
  }
  for (const [index, item] of roster.entries()) {
    const pickup = manager.getPickup(item.id);
    if (!pickup) {
      throw new Error(`Pickup was not created: ${item.typeId}`);
    }
    pickup.orbitCenter = { x: 0, y: 0 };
    pickup.orbitPhase = index * 0.4;
    pickup.driftAngle = index * 0.7;
    pickup.position = { x: 40, y: 0 };
    pickup.velocity = { x: 0, y: 0 };
  }
  const frames: SatelliteDemoPanel[][] = [];
  for (let frame = 0; frame < frameCount; frame++) {
    if (frame > 0) {
      for (let tick = 0; tick < ticksPerFrame; tick++) {
        manager.update([]);
      }
    }
    frames.push(
      manager.getAllPickups().map((pickup) => ({
        pickup: structuredClone(pickup),
      }))
    );
  }
  if (
    !frames.every((panels) => panels.length === SATELLITE_PROFILES.length) ||
    new Set(roster.map((pickup) => pickup.typeId)).size !== SATELLITE_PROFILES.length
  ) {
    throw new Error('Satellite demonstration lost an Earth-observation hull');
  }
  return frames;
}
