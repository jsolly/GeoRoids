/* @vitest-environment node */
import { strict as assert } from 'node:assert';
import { expect, test, vi } from 'vitest';
import { AsteroidField } from '../../../server/core/AsteroidField';
import { AsteroidManager } from '../../../server/core/AsteroidManager';
import { EntityManager } from '../../../server/core/EntityManager';
import { GameEngine } from '../../../server/core/GameEngine';
import { RNGService } from '../../../server/core/RNGService';
import { ServerClock } from '../../../server/core/ServerClock';
import { SurveyProbeManager } from '../../../server/core/SurveyProbeManager';
import { RegionalAsteroidField } from '../../../server/world/RegionalAsteroidField';
import {
  ASTEROID_INTERACTIONS,
  layoutReflectiveCluster,
  previewChargedReflections,
  seedAsteroidPhenomena,
} from '../../../shared/asteroidPhenomena';
import { GAME, LASER } from '../../../shared/constants/gameplay';
import type { AsteroidData, Position } from '../../../shared-types';
import { RecordingSocket } from '../../support/recordingSocket';

function rock(id: string, position: Position): AsteroidData {
  return {
    id,
    position: { ...position },
    velocity: { x: 2, y: -1 },
    size: 25,
    jaggedness: 0.2,
    rotation: 0,
    angularVelocity: 0.004,
    health: 25,
    maxHealth: 25,
    vertices: 5,
    offsets: [1, 0.9, 1, 0.85, 1],
    material: 'metal',
  };
}

function seededCluster(center: Position): AsteroidData[] {
  const rocks = [
    rock('cluster-0', center),
    rock('cluster-1', { x: center.x + 1, y: center.y }),
    rock('cluster-2', { x: center.x, y: center.y + 1 }),
  ];
  seedAsteroidPhenomena(rocks);
  return rocks;
}

function externalLane(center: Position) {
  const angle = (Math.PI * 3) / 10;
  return {
    start: {
      x: center.x + Math.cos(angle) * 300,
      y: center.y + Math.sin(angle) * 300,
    },
    velocity: {
      x: -Math.cos(angle) * (LASER.SPEED / GAME.FPS),
      y: -Math.sin(angle) * (LASER.SPEED / GAME.FPS),
    },
  };
}

test('a seeded reflective cluster presents an inward-facet pinball path from outside', () => {
  const center = { x: 0, y: 0 };
  const cluster = seededCluster(center);
  const placement = layoutReflectiveCluster(center);

  expect(cluster).toHaveLength(ASTEROID_INTERACTIONS.rocksPerCluster);
  expect(placement).toHaveLength(ASTEROID_INTERACTIONS.rocksPerCluster);
  for (const [index, asteroid] of cluster.entries()) {
    const expected = placement[index];
    assert.ok(expected, `placement ${index}`);
    expect(asteroid.position).toEqual(expected.position);
    expect(asteroid.rotation).toBe(expected.rotation);
    expect(asteroid.velocity).toEqual({ x: 0, y: 0 });
    expect(asteroid.size).toBe(ASTEROID_INTERACTIONS.reflectiveSize);
    expect(asteroid.phenomenon?.kind).toBe('reflective');
  }

  const lane = externalLane(center);
  const preview = previewChargedReflections(lane.start, lane.velocity, cluster, 800);
  expect(preview.impacts.length).toBeGreaterThanOrEqual(3);
  expect(new Set(preview.impacts.map((impact) => impact.asteroidId)).size).toBeGreaterThanOrEqual(
    2
  );
});

test('an external pilot shot ricochets through the seeded cluster in GameEngine physics', () => {
  const center = { x: 0, y: 0 };
  const cluster = seededCluster(center);
  const engine = new GameEngine(419);
  for (const asteroid of engine.getAllAsteroids()) {
    engine.asteroidLifecycle.remove(asteroid.id);
  }
  for (const asteroid of cluster) {
    engine.asteroidLifecycle.insert(asteroid);
  }

  const lane = externalLane(center);
  const shot = engine.spawnLaser('pilot', lane.start, lane.velocity);
  assert.ok(shot, 'external laser');
  for (let frame = 0; frame < 180; frame += 1) {
    engine.advanceLasersAndResolveHits();
  }

  expect(shot.bounces).toBeGreaterThanOrEqual(3);
  expect(shot.energy).toBeCloseTo(3.375);
  expect(engine.getServerLasers()).toContain(shot);
  expect(
    cluster.filter((asteroid) => {
      const current = engine.getAsteroid(asteroid.id);
      return current?.phenomenon?.kind === 'reflective' && current.phenomenon.energy > 0;
    })
  ).toHaveLength(ASTEROID_INTERACTIONS.rocksPerCluster);
});

function fixtureRuntime() {
  const rng = new RNGService(419);
  const actors = new EntityManager(rng, () => 1_790_000_000_000);
  actors.addPlayer('human', 'Human', undefined, { x: 0, y: 0 });
  const rocks = new AsteroidManager(rng);
  const field = new AsteroidField({
    actors,
    rocks,
    regional: new RegionalAsteroidField(419),
    probes: new SurveyProbeManager(),
    isPaused: () => false,
    now: () => 1_790_000_000_000,
  });
  return { rocks, field };
}

test('fixture decoration waits for rocks, runs once on its cadence and refiles moved cluster members', () => {
  const { rocks, field } = fixtureRuntime();
  expect(field.createFixtures(0, undefined)).toEqual([]);
  field.advanceFixtureSeeding(60);
  const rows = Array.from({ length: 12 }, (_, index) =>
    rock(`fixture-${index}`, { x: index * 10_000, y: 0 })
  );
  for (const row of rows) {
    rocks.addAsteroid(row);
  }
  field.advanceFixtureSeeding(119);
  expect(rows.filter((row) => row.phenomenon)).toHaveLength(0);
  field.advanceFixtureSeeding(120);
  expect(rows.filter((row) => row.phenomenon?.kind === 'reflective')).toHaveLength(6);
  const moved = rows[1];
  assert.ok(moved);
  expect(Math.hypot(moved.position.x, moved.position.y)).toBeCloseTo(44);
  expect(rocks.spatialIndex().query({ minX: -100, minY: -100, maxX: 100, maxY: 100 })).toContain(
    moved
  );
  expect(field.createFixtures(999, undefined)[1]).toBe(moved);
  field.advanceFixtureSeeding(180);
  expect(rows.filter((row) => row.phenomenon?.kind === 'reflective')).toHaveLength(6);
});

test('clearing decoration preserves fixture mode while restoring regional mode stops fixture decoration', () => {
  const { rocks, field } = fixtureRuntime();
  field.createFixtures(0, undefined);
  for (let index = 0; index < 12; index++) {
    rocks.addAsteroid(rock(`old-${index}`, { x: index * 100, y: 0 }));
  }
  field.seedFixtures();
  rocks.clearAsteroids();
  const replacements = Array.from({ length: 12 }, (_, index) =>
    rock(`new-${index}`, { x: index * 100, y: 0 })
  );
  for (const row of replacements) {
    rocks.addAsteroid(row);
  }
  field.seedFixtures();
  expect(replacements.filter((row) => row.phenomenon)).toHaveLength(0);
  field.forgetFixtureDecoration();
  expect(field.mode).toBe('fixture');
  expect(field.ensure()).toEqual([]);
  expect(replacements.filter((row) => row.phenomenon?.kind === 'reflective')).toHaveLength(6);
  field.forgetFixtureDecoration();
  field.restoreRegionalMode();
  field.seedFixtures();
  expect(replacements.filter((row) => row.phenomenon?.kind === 'reflective')).toHaveLength(6);
  expect(field.mode).toBe('regional');
});

test('a fixture creation failure still leaves regional generation disabled', () => {
  const { rocks, field } = fixtureRuntime();
  const creation = vi.spyOn(rocks, 'createAsteroids').mockImplementationOnce(() => {
    throw new Error('fixture creation failed');
  });
  try {
    expect(() => field.createFixtures(12, undefined)).toThrow('fixture creation failed');
    expect(field.ensure()).toEqual([]);
    expect(rocks.getAsteroidCount()).toBe(0);
    expect(field.mode).toBe('fixture');
  } finally {
    creation.mockRestore();
  }
});

test.each([false, true])(
  'an admitted full frame seeds before lasers even when its last pilot becomes stale: %s',
  (stale) => {
    const now = 1_790_000_000_000;
    const clock = new ServerClock({ wallNow: () => now, monotonicNow: () => 0 });
    const engine = new GameEngine(419, clock);
    try {
      engine.createAsteroids(0);
      const pilot = engine.addPlayer('pilot', 'Pilot', new RecordingSocket(), {
        x: -5_000,
        y: -5_000,
      });
      pilot.overlayHold = true;
      const rows = Array.from({ length: 12 }, (_, index) => ({
        ...rock(`frame-fixture-${index}`, { x: index * 1_000, y: 0 }),
        velocity: { x: 0, y: 0 },
        angularVelocity: 0,
      }));
      for (const row of rows) {
        engine.asteroidLifecycle.insert(row);
      }
      for (let frame = 0; frame < 59; frame++) {
        engine.advanceOneFrame(now);
      }
      expect(rows.filter((row) => row.phenomenon)).toHaveLength(0);
      const shot = engine.spawnLaser('pilot', { x: 960, y: 0 }, { x: 80, y: 0 });
      assert.ok(shot);
      if (stale) {
        pilot.lastUpdate = now - 30_001;
      }
      engine.advanceOneFrame(now);
      expect(engine.getDiagnostics().gameTime).toBe(60);
      expect(engine.isGamePaused()).toBe(stale);
      expect(engine.getPlayer('pilot') === undefined).toBe(stale);
      expect(rows.filter((row) => row.phenomenon?.kind === 'reflective')).toHaveLength(6);
      expect(shot.hasExploded).toBe(false);
      expect(shot.age).toBe(stale ? 0 : 1);
      expect(engine.getServerLasers().includes(shot)).toBe(!stale);
    } finally {
      engine.stopGameLoop();
    }
  }
);
