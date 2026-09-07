import { describe, expect, test, vi } from 'vitest';
import { RNGService } from '../../../server/core/RNGService';
import { SatelliteManager } from '../../../server/core/SatelliteManager';
import { SatellitePickupManager } from '../../../server/core/SatellitePickupManager';
import { SATELLITE_PROFILES, type SatelliteTypeId } from '../../../shared/eoSatellites';

function firstBurst(typeId: SatelliteTypeId) {
  const rng = new RNGService(42);
  vi.spyOn(rng, 'random').mockReturnValue(0.5);
  const manager = new SatelliteManager(rng);
  const satellite = manager.createSatellites(6).find((row) => row.typeId === typeId)!;
  const profile = SATELLITE_PROFILES.find((row) => row.typeId === typeId)!;
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
      const velocity = manager.getSatellite(satellite.id)!.velocity;
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
    expect(shots.map((shot) => shot.frame - shots[0]!.frame)).toEqual([0, 4, 8]);
    expect(angleDifference(shots[1]!.angle, shots[0]!.angle)).toBeCloseTo(0.16);
    expect(angleDifference(shots[2]!.angle, shots[1]!.angle)).toBeCloseTo(0.16);
  });

  test('Aqua rotates a six-shot burst around the whole satellite', () => {
    const shots = firstBurst('aqua');
    expect(shots.map((shot) => shot.frame - shots[0]!.frame)).toEqual([0, 7, 14, 21, 28, 35]);
    for (let i = 1; i < shots.length; i += 1) {
      expect(angleDifference(shots[i]!.angle, shots[i - 1]!.angle)).toBeCloseTo(Math.PI / 3);
    }
  });

  test('GOES holds a rapid collinear beam and ENVISAT sweeps the opposite direction', () => {
    const beam = firstBurst('goes-16');
    expect(beam.map((shot) => shot.frame - beam[0]!.frame)).toEqual([0, 2, 4, 6]);
    for (const shot of beam) {
      expect(angleDifference(shot.angle, beam[0]!.angle)).toBeCloseTo(0);
    }
    const radar = firstBurst('envisat');
    expect(radar[1]!.frame - radar[0]!.frame).toBe(6);
    expect(angleDifference(radar[1]!.angle, radar[0]!.angle)).toBeCloseTo(-0.24);
  });

  test('WorldView fires a faster single precision shot than Landsat', () => {
    expect(firstBurst('worldview-3')[0]!.speed).toBeGreaterThan(firstBurst('landsat-7')[0]!.speed);
  });
});

test('arena resets and independent worlds cannot reuse satellite or pickup identities', () => {
  const manager = new SatelliteManager(new RNGService(42));
  const oldSatellite = manager.createSatellites(1)[0]!;
  manager.clearSatellites();
  const nextSatellite = manager.createSatellites(1)[0]!;
  expect(nextSatellite.id).not.toBe(oldSatellite.id);
  expect(manager.damageSatellite(oldSatellite.id, 100)).toBeUndefined();
  expect(new SatelliteManager(new RNGService(42)).createSatellites(1)[0]!.id).not.toBe(nextSatellite.id);

  const pickups = new SatellitePickupManager(new RNGService(42));
  const oldPickup = pickups.createPickups(1)[0]!;
  pickups.clear();
  const nextPickup = pickups.createPickups(1)[0]!;
  expect(nextPickup.id).not.toBe(oldPickup.id);
  expect(pickups.collect(oldPickup.id, 'pilot', 0)).toBeNull();
});
