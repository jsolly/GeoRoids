import { assert, describe, expect, test, vi } from 'vitest';
import { RNGService } from '../../../server/core/RNGService';
import { SatelliteManager } from '../../../server/core/SatelliteManager';
import { SatellitePickupManager } from '../../../server/core/SatellitePickupManager';
import { SATELLITE_PROFILES, type SatelliteTypeId } from '../../../shared/eoSatellites';

function firstBurst(typeId: SatelliteTypeId) {
  const rng = new RNGService(42);
  vi.spyOn(rng, 'random').mockReturnValue(0.5);
  const manager = new SatelliteManager(rng);
  const satellite = manager.createSatellites(6).find((row) => row.typeId === typeId);
  assert.exists(satellite);
  const profile = SATELLITE_PROFILES.find((row) => row.typeId === typeId);
  assert.exists(profile);
  const samples: Array<{ frame: number; angle: number; speed: number }> = [];
  for (let frame = 0; frame < 350 && samples.length < profile.burstCount; frame += 1) {
    const shots = manager.update([
      {
        id: 'moving-pilot',
        position: { x: 1200, y: frame * 2 },
        radius: 15,
        health: 100,
        exploding: false,
      },
    ]);
    for (const shot of shots.filter((row) => row.id === satellite.id)) {
      const currentSatellite = manager.getSatellite(satellite.id);
      assert.exists(currentSatellite);
      const velocity = currentSatellite.velocity;
      const x = shot.laserDirection.x - velocity.x;
      const y = shot.laserDirection.y - velocity.y;
      samples.push({ frame, angle: Math.atan2(-y, x), speed: Math.hypot(x, y) });
    }
  }
  expect(samples).toHaveLength(profile.burstCount);
  return samples;
}

function angleDifference(a: number, b: number): number {
  return Math.atan2(Math.sin(a - b), Math.cos(a - b));
}

describe('EO firing patterns remain recognizable while a pilot moves', () => {
  test('Terra finishes a spaced fan instead of restarting a burst during its pause', () => {
    const shots = firstBurst('terra');
    const [firstShot, secondShot, thirdShot] = shots;
    assert.exists(firstShot);
    assert.exists(secondShot);
    assert.exists(thirdShot);
    expect(shots.map((shot) => shot.frame - firstShot.frame)).toEqual([0, 4, 8]);
    expect(angleDifference(secondShot.angle, firstShot.angle)).toBeCloseTo(0.16);
    expect(angleDifference(thirdShot.angle, secondShot.angle)).toBeCloseTo(0.16);
  });

  test('Aqua rotates a six-shot burst around the whole satellite', () => {
    const shots = firstBurst('aqua');
    const firstShot = shots[0];
    assert.exists(firstShot);
    expect(shots.map((shot) => shot.frame - firstShot.frame)).toEqual([0, 7, 14, 21, 28, 35]);
    for (let i = 1; i < shots.length; i += 1) {
      const shot = shots[i];
      const previousShot = shots[i - 1];
      assert.exists(shot);
      assert.exists(previousShot);
      expect(angleDifference(shot.angle, previousShot.angle)).toBeCloseTo(Math.PI / 3);
    }
  });

  test('GOES holds a rapid collinear beam and ENVISAT sweeps the opposite direction', () => {
    const beam = firstBurst('goes-16');
    const firstBeamShot = beam[0];
    assert.exists(firstBeamShot);
    expect(beam.map((shot) => shot.frame - firstBeamShot.frame)).toEqual([0, 2, 4, 6]);
    for (const shot of beam) {
      expect(angleDifference(shot.angle, firstBeamShot.angle)).toBeCloseTo(0);
    }
    const radar = firstBurst('envisat');
    const radarFirstShot = radar[0];
    const radarSecondShot = radar[1];
    assert.exists(radarFirstShot);
    assert.exists(radarSecondShot);
    expect(radarSecondShot.frame - radarFirstShot.frame).toBe(6);
    expect(angleDifference(radarSecondShot.angle, radarFirstShot.angle)).toBeCloseTo(-0.24);
  });

  test('WorldView fires a faster single precision shot than Landsat', () => {
    const worldviewShot = firstBurst('worldview-3')[0];
    const landsatShot = firstBurst('landsat-7')[0];
    assert.exists(worldviewShot);
    assert.exists(landsatShot);
    expect(worldviewShot.speed).toBeGreaterThan(landsatShot.speed);
  });
});

test('arena resets and independent worlds cannot reuse satellite or pickup identities', () => {
  const manager = new SatelliteManager(new RNGService(42));
  const oldSatellite = manager.createSatellites(1)[0];
  assert.exists(oldSatellite);
  manager.clearSatellites();
  const nextSatellite = manager.createSatellites(1)[0];
  assert.exists(nextSatellite);
  expect(nextSatellite.id).not.toBe(oldSatellite.id);
  expect(manager.damageSatellite(oldSatellite.id, 100)).toBeUndefined();
  const independentSatellite = new SatelliteManager(new RNGService(42)).createSatellites(1)[0];
  assert.exists(independentSatellite);
  expect(independentSatellite.id).not.toBe(nextSatellite.id);

  const pickups = new SatellitePickupManager(new RNGService(42));
  const oldPickup = pickups.createPickups(1)[0];
  assert.exists(oldPickup);
  pickups.clear();
  const nextPickup = pickups.createPickups(1)[0];
  assert.exists(nextPickup);
  expect(nextPickup.id).not.toBe(oldPickup.id);
  expect(pickups.collect(oldPickup.id, 'pilot', 0)).toBeNull();
});
