/* @vitest-environment node */
import { expect, test } from 'vitest';
import { AsteroidManager } from '../../../server/core/AsteroidManager';
import { RNGService } from '../../../server/core/RNGService';
import { RegionalAsteroidField } from '../../../server/world/RegionalAsteroidField';
import { WorldStore } from '../../../server/world/WorldStore';
import { ASTEROID_BOOST } from '../../../shared/asteroidBoost';
import type { AsteroidData } from '../../../shared-types';

function rock(): AsteroidData {
  return {
    id: 'powered-deposit',
    position: { x: 500, y: 500 },
    velocity: { x: 0, y: 0 },
    size: 25,
    jaggedness: 0.2,
    rotation: 0,
    angularVelocity: 0,
    health: 75,
    maxHealth: 75,
    vertices: 4,
    offsets: [1, 1, 1, 1],
    boost: { phase: 'burning', angle: 0, remainingFrames: ASTEROID_BOOST.burnFrames },
  };
}

test('a powered sector stays awake after its observer leaves, then sleeps with the coasting rock', () => {
  const deposit = rock();
  const field = new RegionalAsteroidField(42, new Map([['0,0', [deposit]]]));
  const manager = new AsteroidManager(new RNGService(42));
  field.update(manager, [{ x: 500, y: 500 }], new Set());
  field.update(manager, [], new Set());
  expect(manager.getAsteroid(deposit.id)).toBe(deposit);
  for (let frame = 0; frame < ASTEROID_BOOST.burnFrames; frame++) {
    manager.updateMotion();
  }
  expect(deposit.boost).toBeNull();
  expect(deposit.position.x).toBeGreaterThan(500);
  field.update(manager, [], new Set());
  expect(manager.getAsteroid(deposit.id)).toBeUndefined();
  const saved = field
    .checkpoint(manager)
    .get('0,0')
    ?.find((row) => row.id === deposit.id);
  expect(saved?.boost).toBeNull();
  expect(saved?.velocity.x).toBeCloseTo(ASTEROID_BOOST.maxSpeed);
});

test('a checkpoint restores the remaining simulation-time fuel without replaying the whole burn', () => {
  const store = new WorldStore(':memory:');
  try {
    const manager = new AsteroidManager(new RNGService(42));
    const deposit = rock();
    manager.addAsteroid(deposit);
    for (let frame = 0; frame < 60; frame++) {
      manager.updateMotion();
    }
    store.checkpoint(undefined, new Map([['0,0', [deposit]]]), []);
    const restored = store.loadSector('0,0')?.[0];
    expect(restored?.boost).toEqual({ phase: 'burning', angle: 0, remainingFrames: 120 });
    if (!restored) {
      throw new Error('Checkpoint lost the deposit');
    }
    const restarted = new AsteroidManager(new RNGService(42));
    restarted.addAsteroid(restored);
    for (let frame = 0; frame < 120; frame++) {
      restarted.updateMotion();
    }
    expect(restored.boost).toBeNull();
    expect(restored.velocity.x).toBeCloseTo(ASTEROID_BOOST.maxSpeed);
  } finally {
    store.close();
  }
});
