/* @vitest-environment node */
import { strict as assert } from 'node:assert';
import { expect, test } from 'vitest';
import { GameEngine } from '../../../server/core/GameEngine';
import {
  ASTEROID_INTERACTIONS,
  layoutReflectiveCluster,
  previewChargedReflections,
  seedAsteroidPhenomena,
} from '../../../shared/asteroidPhenomena';
import type { AsteroidData, Position } from '../../../shared-types';
import { GAME, LASER } from '../../../src/constants';

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
    engine.removeAsteroid(asteroid.id);
  }
  for (const asteroid of cluster) {
    engine.addAsteroid(asteroid);
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
