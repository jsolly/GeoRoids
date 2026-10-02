import { expect, test } from 'vitest';
import { AsteroidManager } from '../../../server/core/AsteroidManager';
import { CollisionAuthority } from '../../../server/core/CollisionAuthority';
import { GameEngine } from '../../../server/core/GameEngine';
import { RNGService } from '../../../server/core/RNGService';
import { AsteroidSpatialIndex } from '../../../server/world/AsteroidSpatialIndex';
import { nearbyAsteroidRows } from '../../../shared/world';
import type { AsteroidData } from '../../../shared-types';
import { RecordingSocket } from '../../support/recordingSocket';

function rock(id: string, x: number, y: number, size = 25): AsteroidData {
  return {
    id,
    position: { x, y },
    velocity: { x: 0, y: 0 },
    size,
    offsets: [1, 1, 1, 1],
    vertices: 4,
    jaggedness: 0,
    health: 25,
    maxHealth: 25,
    rotation: 0,
    angularVelocity: 0,
  };
}

test('distant sectors do not become collision candidates and large rocks retain source priority across grid seams', () => {
  const distant = Array.from({ length: 10000 }, (_, i) =>
    rock(`far-${i}`, 10000 + (i % 100) * 400, 10000 + Math.floor(i / 100) * 400)
  );
  const spanning = rock('spanning', 1100, 0, 700);
  const small = rock('small', 510, 0);
  const index = new AsteroidSpatialIndex([spanning, small, ...distant]);
  const nearby = index.query({ minX: 480, maxX: 540, minY: -30, maxY: 30 });
  expect(nearby.map((candidate) => candidate.id)).toEqual(['spanning', 'small']);
  const engine = new GameEngine(82);
  const pilot = engine.addPlayer('pilot', 'Pilot', new RecordingSocket(), { x: 510, y: 0 });
  pilot.spawnProtectionTimer = 0;
  const collisions = new CollisionAuthority();
  expect(collisions.collectShipAsteroidHits([pilot], index)).toEqual([
    { shipId: pilot.id, asteroidId: 'spanning' },
  ]);
  expect(
    collisions.collectShipAsteroidHits(
      [pilot],
      index,
      (_pilot, candidate) => candidate.id !== 'spanning'
    )
  ).toEqual([{ shipId: pilot.id, asteroidId: 'small' }]);
  expect(collisions.collectTowedAsteroidHits([small], index)).toEqual([
    { towedId: 'small', otherId: 'spanning' },
  ]);
});

test('a swept query covers every crossed cell and fragments enter the current frame', () => {
  const middle = rock('middle', 1000, 0);
  const index = new AsteroidSpatialIndex([middle, rock('unrelated', 0, 4000)]);
  expect(
    index.query({ minX: 0, maxX: 2000, minY: 0, maxY: 0 }).map((candidate) => candidate.id)
  ).toEqual(['middle']);
  const fragment = rock('fragment', -520, 0);
  index.add(fragment);
  expect(index.query({ minX: -530, maxX: -510, minY: -10, maxY: 10 })).toEqual([fragment]);
});

test('one shared index follows mining, splits, edits and drift without being rebuilt', () => {
  const manager = new AsteroidManager(new RNGService(7));
  const mined = rock('mined', 100, 0);
  const drifter = { ...rock('drifter', 300, 0), velocity: { x: 40, y: 0 } };
  manager.addAsteroid(mined);
  manager.addAsteroid(drifter);
  const near = { minX: 0, maxX: 400, minY: -50, maxY: 50 };
  const index = manager.spatialIndex();
  expect(manager.spatialIndex()).toBe(index);
  expect(index.query(near).map((candidate) => candidate.id)).toEqual(['mined', 'drifter']);

  // A mined rock leaves later queries this frame; a new fragment joins them.
  manager.removeAsteroid(mined.id);
  const fragment = rock('fragment', 200, 0, 10);
  manager.addAsteroid(fragment);
  expect(manager.spatialIndex()).toBe(index);
  expect(index.query(near).map((candidate) => candidate.id)).toEqual(['drifter', 'fragment']);

  // Edits and drift re-file rocks in place; the same index stays current.
  manager.updateAsteroid(fragment.id, { position: { x: 5_000, y: 0 } });
  expect(
    manager
      .spatialIndex()
      .query(near)
      .map((candidate) => candidate.id)
  ).toEqual(['drifter']);
  for (let frame = 0; frame < 10; frame++) {
    manager.updateMotion();
  }
  const moved = manager.spatialIndex();
  expect(moved).toBe(index);
  expect(moved.query(near)).toEqual([]);
  expect(
    moved
      .query({
        minX: drifter.position.x - 1,
        maxX: drifter.position.x + 1,
        minY: -1,
        maxY: 1,
      })
      .map((candidate) => candidate.id)
  ).toEqual(['drifter']);
});

test('a scanning Scout receives the rocks its zoomed-out camera shows, then only its radar again', () => {
  const pilot = { x: 0, y: 0 };
  const onRadar = rock('on-radar', 1_200, 900);
  const scanEdge = rock('scan-edge', 2_450, 0);
  const beyond = rock('beyond', 3_200, 0);
  const rows = [onRadar, scanEdge, beyond];
  expect(nearbyAsteroidRows(rows, pilot).map((candidate) => candidate.id)).toEqual(['on-radar']);
  expect(nearbyAsteroidRows(rows, pilot, true).map((candidate) => candidate.id)).toEqual([
    'on-radar',
    'scan-edge',
  ]);
});

test('a rock drifting into another keeps its collision priority, replacements keep their slot, and clearing empties the field', () => {
  const manager = new AsteroidManager(new RNGService(7));
  const first = { ...rock('first-ice', 480, 0, 20), velocity: { x: 50, y: 0 } };
  const second = rock('second-ice', 540, 0, 20);
  manager.addAsteroid(first);
  manager.addAsteroid(second);
  // First drifts across the 512-unit cell edge onto second's hull.
  manager.updateMotion();
  expect(first.position.x).toBeGreaterThan(512);
  const index = manager.spatialIndex();
  const overlap = { minX: 520, maxX: 560, minY: -5, maxY: 5 };
  expect(index.query(overlap).map((candidate) => candidate.id)).toEqual([
    'first-ice',
    'second-ice',
  ]);
  const engine = new GameEngine(82);
  const pilot = engine.addPlayer('pilot', 'Pilot', new RecordingSocket(), { x: 540, y: 0 });
  pilot.spawnProtectionTimer = 0;
  expect(new CollisionAuthority().collectShipAsteroidHits([pilot], index)).toEqual([
    { shipId: pilot.id, asteroidId: 'first-ice' },
  ]);
  engine.stopGameLoop();

  // Re-adding the same ID keeps one copy in its original slot.
  const replacement = { ...first, health: 5 };
  manager.addAsteroid(replacement);
  expect(index.query(overlap)).toEqual([replacement, second]);

  manager.clearAsteroids();
  expect(index.query({ minX: -5_000, maxX: 5_000, minY: -5_000, maxY: 5_000 })).toEqual([]);
  const fresh = rock('fresh-ice', 530, 0);
  manager.addAsteroid(fresh);
  expect(manager.spatialIndex().query(overlap)).toEqual([fresh]);
});

test('reflective pockets arranged in place are found where lasers and ships meet them', () => {
  const engine = new GameEngine(82);
  const pilot = engine.addPlayer('pilot', 'Pilot', new RecordingSocket(), { x: 0, y: 0 });
  try {
    pilot.spawnProtectionTimer = 999;
    // A diagnostic field replaces the regional one; its pocket is arranged in place.
    for (const existing of engine.getAllAsteroids()) {
      engine.removeAsteroid(existing.id);
    }
    engine.createAsteroids(20);
    let pocket: ReturnType<GameEngine['getAllAsteroids']> = [];
    for (let frame = 0; frame < 120 && pocket.length === 0; frame++) {
      engine.advanceOneFrame();
      pocket = engine
        .getAllAsteroids()
        .filter((candidate) => candidate.phenomenon?.kind === 'reflective');
    }
    expect(pocket.length).toBeGreaterThan(0);
    const index = engine.getAsteroidSpatialIndex();
    for (const reflector of pocket) {
      expect(
        index.query({
          minX: reflector.position.x - 1,
          maxX: reflector.position.x + 1,
          minY: reflector.position.y - 1,
          maxY: reflector.position.y + 1,
        })
      ).toContain(reflector);
    }
  } finally {
    engine.stopGameLoop();
  }
});

test('two pilots discover one asteroid union in global source order despite overlap and pilot order', () => {
  const earlier = rock('earlier-only-second-pilot', 4000, 0);
  const later = rock('later-only-first-pilot', -4000, 0);
  const shared = rock('shared', 0, 0);
  const distant = rock('distant', 20000, 20000);
  const index = new AsteroidSpatialIndex([earlier, later, shared, distant]);
  const first = { minX: -4200, maxX: 200, minY: -100, maxY: 100 };
  const second = { minX: -200, maxX: 4200, minY: -100, maxY: 100 };
  expect(index.queryMany([first, second, first])).toEqual([earlier, later, shared]);
  expect(index.queryMany([second, first])).toEqual([earlier, later, shared]);
  const replacement = rock(earlier.id, 1000, 0);
  index.add(replacement);
  expect(index.queryMany([first, second])).toEqual([replacement, later, shared]);
  index.remove(later.id);
  index.add(later);
  expect(index.queryMany([first, second])).toEqual([replacement, shared, later]);
  index.clear();
  expect(index.queryMany([first, second])).toEqual([]);
});
