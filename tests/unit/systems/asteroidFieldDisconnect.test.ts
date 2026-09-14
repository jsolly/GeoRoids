import { expect, test } from 'vitest';
import { GameEngine } from '../../../server/core/GameEngine';
import { RecordingSocket } from '../../support/recordingSocket';

test('disconnecting one of two humans does not clear or pause the shared field', () => {
  const engine = new GameEngine(3);
  engine.createAsteroids(10);
  engine.addPlayer('peer-a', 'PeerA', new RecordingSocket());
  engine.addPlayer('peer-b', 'PeerB', new RecordingSocket());

  const idsBefore = engine
    .getAllAsteroids()
    .map((asteroid) => asteroid.id)
    .sort();
  expect(idsBefore.length).toBeGreaterThan(0);
  expect(engine.isGamePaused()).toBe(false);

  engine.removePlayer('peer-b');

  expect(engine.isGamePaused()).toBe(false);
  expect(engine.getPlayerCount()).toBe(1);
  expect(
    engine
      .getAllAsteroids()
      .map((asteroid) => asteroid.id)
      .sort()
  ).toEqual(idsBefore);

  engine.removePlayer('peer-a');
  expect(engine.isGamePaused()).toBe(true);
  expect(
    engine
      .getAllAsteroids()
      .map((asteroid) => asteroid.id)
      .sort()
  ).toEqual(idsBefore);
});

test('a depleted active field stays empty instead of regenerating harvested deposits', () => {
  const engine = new GameEngine(7);
  const player = engine.addPlayer('pilot', 'Pilot', new RecordingSocket(), { x: 0, y: 0 });
  const firstField = engine.getAllAsteroids();
  const firstIds = new Set(firstField.map((asteroid) => asteroid.id));

  expect(player.type).toBe('human');
  expect(firstField.length).toBeGreaterThan(0);
  expect(engine.isGamePaused()).toBe(false);

  for (const asteroid of firstField) {
    engine.removeAsteroid(asteroid.id);
  }
  expect(engine.getAsteroidCount()).toBe(0);

  // No reconnect or new player is involved. Depleted deposits remain depleted.
  engine.advanceOneFrame();
  const secondField = engine.getAllAsteroids();
  expect(secondField).toEqual([]);
  expect(secondField.every((asteroid) => !firstIds.has(asteroid.id))).toBe(true);

  engine.removePlayer('pilot');
  engine.stopGameLoop();
});
