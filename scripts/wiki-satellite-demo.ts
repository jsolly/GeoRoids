import { RNGService } from '../server/core/RNGService';
import { SatelliteManager } from '../server/core/SatelliteManager';
import { SATELLITE_PROFILES } from '../shared/eoSatellites';
import type { SatelliteData, SatelliteProjectileState } from '../shared-types';

export interface SatelliteDemoPanel {
  satellite: SatelliteData;
  projectiles: SatelliteProjectileState[];
}

/** Record the real server's patrol, burst scheduling, shot geometry and projectile
 * lifetimes. All six start in matching controlled conditions so differences are
 * caused by their profiles. UUIDs are never rendered or used to seed motion. */
export function recordSatelliteDemo(
  frameCount: number,
  ticksPerFrame: number
): SatelliteDemoPanel[][] {
  const manager = new SatelliteManager(new RNGService(0x507a112e));
  const roster = manager.createSatellites(SATELLITE_PROFILES.length);
  if (roster.length !== SATELLITE_PROFILES.length) {
    throw new Error('Satellite demonstration requires the complete live roster');
  }
  const fired = new Map<string, number>();
  for (const item of roster) {
    const satellite = manager.getSatellite(item.id);
    if (!satellite) {
      throw new Error(`Satellite was not created: ${item.typeId}`);
    }
    satellite.orbitCenter = { x: 0, y: 0 };
    satellite.orbitPhase = 0;
    satellite.driftAngle = 0;
    satellite.position = { x: satellite.orbitRadiusX, y: 0 };
    satellite.velocity = { x: 0, y: 0 };
    // Synchronize the first volley only; all subsequent cadence, burst gaps,
    // jitter, aim and motion are advanced exclusively by SatelliteManager.
    satellite.shootCooldown = 12;
    fired.set(item.id, 0);
  }
  const target = {
    id: 'wiki-target',
    position: { x: 450, y: 0 },
    radius: 15,
    health: 100,
    exploding: false,
  };
  const frames: SatelliteDemoPanel[][] = [];
  for (let frame = 0; frame < frameCount; frame++) {
    if (frame > 0) {
      for (let tick = 0; tick < ticksPerFrame; tick++) {
        for (const shot of manager.update([target])) {
          fired.set(shot.id, (fired.get(shot.id) ?? 0) + 1);
        }
        manager.drainHits();
      }
    }
    const projectiles = manager.getActiveProjectiles();
    frames.push(
      manager.getAllSatellites().map((satellite) => ({
        satellite: structuredClone(satellite),
        projectiles: projectiles.filter((shot) => shot.satelliteId === satellite.id),
      }))
    );
  }
  for (const item of roster) {
    const profile = SATELLITE_PROFILES.find((candidate) => candidate.typeId === item.typeId);
    if (!profile || (fired.get(item.id) ?? 0) < profile.burstCount) {
      throw new Error(`Satellite demonstration missed a complete volley: ${item.typeId}`);
    }
  }
  return frames;
}
