import { expect, test } from 'vitest';
import { CollisionAuthority } from '../../../server/core/CollisionAuthority';
import { GameEngine } from '../../../server/core/GameEngine';
import { AsteroidSpatialIndex } from '../../../server/world/AsteroidSpatialIndex';
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
  expect(collisions.collectShipAsteroidHits([pilot], [spanning, small, ...distant])).toEqual([
    { shipId: pilot.id, asteroidId: 'spanning' },
  ]);
  expect(
    collisions.collectShipAsteroidHits(
      [pilot],
      [spanning, small, ...distant],
      (_pilot, id) => id === 'spanning'
    )
  ).toEqual([{ shipId: pilot.id, asteroidId: 'small' }]);
  expect(collisions.collectTowedAsteroidHits([small], [spanning, small, ...distant])).toEqual([
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
