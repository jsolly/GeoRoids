import { expect, test } from 'vitest';
import { GameEngine } from '../../../server/core/GameEngine';
import { ROID } from '../../../src/constants';

test('disconnecting one of two humans does not clear or pause the shared field', () => {
  const engine = new GameEngine(3);
  engine.createAsteroids(10);
  engine.addPlayer('peer-a', 'PeerA', {} as never);
  engine.addPlayer('peer-b', 'PeerB', {} as never);

  const idsBefore = engine.getAllAsteroids().map((asteroid) => asteroid.id).sort();
  expect(idsBefore.length).toBeGreaterThan(0);
  expect(engine.isGamePaused()).toBe(false);

  engine.removePlayer('peer-b');

  expect(engine.isGamePaused()).toBe(false);
  expect(engine.getPlayerCount()).toBe(1);
  expect(engine.getAllAsteroids().map((asteroid) => asteroid.id).sort()).toEqual(idsBefore);

  engine.removePlayer('peer-a');
  expect(engine.isGamePaused()).toBe(true);
  expect(engine.getAsteroidCount()).toBe(0);
});

test('an active arena reseeds the canonical belt after its last asteroid is destroyed', () => {
  const engine = new GameEngine(7);
  const player = engine.addPlayer('pilot', 'Pilot', {} as never, { x: 0, y: 0 });
  const firstField = engine.getAllAsteroids();
  const firstIds = new Set(firstField.map((asteroid) => asteroid.id));

  expect(player.type).toBe('human');
  expect(firstField).toHaveLength(ROID.INITIAL_ROID_COUNT);
  expect(engine.isGamePaused()).toBe(false);

  for (const asteroid of firstField) {
    engine.removeAsteroid(asteroid.id);
  }
  expect(engine.getAsteroidCount()).toBe(0);

  // No reconnect or new player is involved; the normal authoritative frame
  // loop owns the repair before the next state broadcast.
  engine.advanceOneFrame();
  const secondField = engine.getAllAsteroids();
  expect(secondField).toHaveLength(ROID.INITIAL_ROID_COUNT);
  expect(secondField.every((asteroid) => !firstIds.has(asteroid.id))).toBe(true);

  engine.removePlayer('pilot');
  engine.stopGameLoop();
});
