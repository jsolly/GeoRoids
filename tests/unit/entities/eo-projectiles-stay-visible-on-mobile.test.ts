import { afterEach, describe, expect, test, vi } from 'vitest';
import type { SatelliteData } from '../../../shared-types';
import { SatelliteManager } from '../../../src/entities/satellite/SatelliteManager';
import { canvasManager } from '../../../src/rendering/canvas';

const satellite: SatelliteData = {
  id: 'eo-mobile',
  name: 'Landsat 7',
  typeId: 'landsat-7',
  assetKey: 'eo/landsat-7',
  shotManner: 'steady-optical-ping',
  position: { x: 0, y: 0 },
  velocity: { x: 0, y: 0 },
  angle: 0,
  exploding: false,
  color: '#C4B5FD',
  health: 50,
  maxHealth: 50,
  radius: 16,
};

afterEach(() => {
  SatelliteManager.getInstance().clear();
  vi.restoreAllMocks();
});

describe('EO projectile visuals follow the authoritative lifetime', () => {
  test('a reconnect restores an old live bolt on a narrow viewport until its server expiry', () => {
    vi.spyOn(canvasManager, 'getCanvas').mockReturnValue({ width: 390 } as HTMLCanvasElement);
    const manager = SatelliteManager.getInstance();
    manager.syncFromServer([satellite]);
    manager.syncProjectilesFromServer([
      {
        satelliteId: satellite.id,
        shotId: 'old-live-shot',
        position: { x: 1200, y: 0 },
        velocity: { x: 10, y: 0 },
        age: 120,
      },
    ]);
    for (let frame = 0; frame < 120; frame += 1) {
      manager.update();
    }
    expect(manager.get(satellite.id)?.lasers).toHaveLength(1);
    expect(manager.get(satellite.id)?.lasers[0]?.position.x).toBe(2400);
    manager.update();
    expect(manager.get(satellite.id)?.lasers).toHaveLength(0);
  });

  test('an NPC death removes its bolts and rejects a late shot event', () => {
    const manager = SatelliteManager.getInstance();
    manager.syncFromServer([satellite]);
    manager.addLaser(satellite.id, 'live-shot', { x: 10, y: 0 }, { x: 5, y: 0 });
    expect(manager.get(satellite.id)?.lasers).toHaveLength(1);
    manager.syncFromServer([{ ...satellite, health: 0, exploding: true }]);
    manager.addLaser(satellite.id, 'late-shot', { x: 10, y: 0 }, { x: 5, y: 0 });
    expect(manager.get(satellite.id)?.lasers).toHaveLength(0);
  });
});
