/* @vitest-environment node */
import { expect, test } from 'vitest';
import { AsteroidManager } from '../../../server/core/AsteroidManager';
import { RNGService } from '../../../server/core/RNGService';
import { RegionalAsteroidField } from '../../../server/world/RegionalAsteroidField';
import { WorldStore } from '../../../server/world/WorldStore';
import { beltAsteroid } from '../../../shared/asteroidBelt';
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
    boost: { phase: 'burning', ownerId: 'pilot', angle: 0 },
  };
}

test('a powered sector stays awake until its rock is delivered or destroyed', () => {
  const deposit = rock();
  const field = new RegionalAsteroidField(42, new Map([['0,0', [deposit]]]));
  const manager = new AsteroidManager(new RNGService(42));
  field.update(manager, [{ x: 500, y: 500 }]);
  field.update(manager, []);
  expect(manager.getAsteroid(deposit.id)).toBe(deposit);
  for (let frame = 0; frame < 240; frame++) {
    manager.updateMotion();
  }
  expect(deposit.boost?.phase).toBe('burning');
  field.update(manager, []);
  expect(manager.getAsteroid(deposit.id)).toBe(deposit);
  manager.removeAsteroid(deposit.id);
  field.update(manager, []);
  expect(
    field
      .checkpoint(manager)
      .get('0,0')
      ?.some((row) => row.id === deposit.id)
  ).toBe(false);
});

test('a checkpoint restores guidance and its original owner', () => {
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
    expect(restored?.boost).toEqual(deposit.boost);
    if (!restored) {
      throw new Error('Checkpoint lost the deposit');
    }
    const restarted = new AsteroidManager(new RNGService(42));
    restarted.addAsteroid(restored);
    for (let frame = 0; frame < 120; frame++) {
      restarted.updateMotion();
    }
    expect(restored.boost).toEqual(expect.objectContaining({ phase: 'burning', ownerId: 'pilot' }));
  } finally {
    store.close();
  }
});

test('saved powered cargo wakes without a nearby observer', () => {
  const deposit = rock();
  const field = new RegionalAsteroidField(42, new Map([['0,0', [deposit]]]));
  const manager = new AsteroidManager(new RNGService(42));
  field.update(manager, []);
  expect(manager.getAsteroid(deposit.id)).toBe(deposit);
  field.update(manager, []);
  expect(manager.getAsteroid(deposit.id)).toBe(deposit);
});

test('a checkpoint cannot put powered cargo to sleep after it crosses a sector edge', () => {
  const deposit = rock();
  const field = new RegionalAsteroidField(
    42,
    new Map([
      ['0,0', [deposit]],
      ['1,0', []],
    ])
  );
  const manager = new AsteroidManager(new RNGService(42));
  field.update(manager, []);
  deposit.position = { x: 2100, y: 500 };
  const rows = field.checkpoint(manager);
  expect(manager.getAsteroid(deposit.id)).toBe(deposit);
  expect(rows.get('1,0')).toContain(deposit);
  expect(rows.get('0,0')).toEqual([]);
});

test.each(['interest update', 'checkpoint'] as const)(
  'guided cargo entering an empty saved sector never regenerates native deposits during %s',
  (operation) => {
    const deposit = rock();
    const field = new RegionalAsteroidField(
      42,
      new Map([
        ['0,0', [deposit]],
        ['1,0', []],
      ])
    );
    const manager = new AsteroidManager(new RNGService(42));
    field.update(manager, []);
    deposit.position = { x: 2100, y: 500 };
    if (operation === 'interest update') {
      field.update(manager, []);
    } else {
      field.checkpoint(manager);
    }
    // The two new belt slots are additive; entering this sector must still
    // restore no ordinary harvested deposits during either activation path.
    const expected = [deposit, beltAsteroid(42, 93, 0), beltAsteroid(42, 96, 0)];
    expect(manager.getAllAsteroids()).toEqual(expected);
    expect(field.checkpoint(manager).get('1,0')).toEqual(expected);
  }
);
