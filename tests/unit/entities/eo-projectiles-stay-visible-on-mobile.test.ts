import assert from 'node:assert/strict';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { RNGService } from '../../../server/core/RNGService';
import { SatelliteManager as ServerSatelliteManager } from '../../../server/core/SatelliteManager';
import type { SatelliteData } from '../../../shared-types';
import * as destructionSounds from '../../../src/audio/destructionSounds';
import { SATELLITE } from '../../../src/constants';
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
  test('a reconnect restores a slower bolt with the same range and exact server expiry', () => {
    vi.spyOn(canvasManager, 'getCanvas').mockReturnValue({ width: 390 } as HTMLCanvasElement);
    expect(SATELLITE.PROJECTILE_MAX_FRAMES).toBe(320);
    const authority = new ServerSatelliteManager(new RNGService(42));
    const [created] = authority.createSatellites(1);
    assert(created);
    const source = authority.getSatellite(created.id);
    assert(source);
    source.shootCooldown = 1;
    const [shot] = authority.update([
      {
        id: 'distant-pilot',
        position: { x: source.position.x + 1000, y: source.position.y },
        radius: 15,
        health: 100,
        exploding: false,
      },
    ]);
    assert(shot);
    const carry = { ...source.velocity };
    expect(
      Math.hypot(shot.laserDirection.x - carry.x, shot.laserDirection.y - carry.y)
    ).toBeCloseTo(3.75);
    for (let frame = 0; frame < 200; frame += 1) {
      authority.update([]);
    }
    const [restored] = authority.getActiveProjectiles();
    assert(restored);
    expect(restored.age).toBe(200);
    const manager = SatelliteManager.getInstance();
    manager.syncFromServer(authority.getAllSatellites());
    manager.syncProjectilesFromServer([restored]);
    for (let frame = 0; frame < 120; frame += 1) {
      authority.update([]);
      manager.update();
    }
    const [live] = authority.getActiveProjectiles();
    assert(live);
    expect(live.age).toBe(320);
    expect(
      Math.hypot(
        live.position.x - shot.laserStart.x - carry.x * 320,
        live.position.y - shot.laserStart.y - carry.y * 320
      )
    ).toBeCloseTo(1200);
    const mirror = manager.get(created.id)?.lasers;
    expect(mirror).toHaveLength(1);
    expect(mirror?.[0]?.position.x).toBeCloseTo(live.position.x);
    expect(mirror?.[0]?.position.y).toBeCloseTo(live.position.y);
    authority.update([]);
    manager.update();
    expect(authority.getActiveProjectiles()).toEqual([]);
    expect(manager.get(created.id)?.lasers).toHaveLength(0);
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

test('satellite explosions sound once per death and never replay from an initial snapshot', () => {
  const sound = vi.spyOn(destructionSounds, 'playDestructionSound').mockImplementation(() => {});
  const manager = SatelliteManager.getInstance();
  const dead = { ...satellite, exploding: true, health: 0 };
  manager.syncFromServer([dead]);
  expect(sound).not.toHaveBeenCalled();
  manager.syncFromServer([satellite]);
  manager.syncFromServer([dead]);
  manager.syncFromServer([dead]);
  expect(sound).toHaveBeenCalledExactlyOnceWith('satellite', satellite.position);
  manager.clear();
  manager.syncFromServer([dead]);
  expect(sound).toHaveBeenCalledTimes(1);
});
