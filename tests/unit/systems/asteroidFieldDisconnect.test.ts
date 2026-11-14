import { expect, test } from 'vitest';
import { GameEngine } from '../../../server/core/GameEngine';
import { RecordingSocket } from '../../support/recordingSocket';

test('disconnecting one of two players does not clear or pause the shared field', () => {
  const engine = new GameEngine(3);
  engine.createAsteroids(10);
  engine.addPlayer('peer-a', 'PeerA', new RecordingSocket());
  engine.addPlayer('peer-b', 'PeerB', new RecordingSocket());

  const idsBefore = engine
    .getAllAsteroids()
    .map((asteroid) => asteroid.id)
    .sort((left, right) => left.localeCompare(right));
  expect(idsBefore.length).toBeGreaterThan(0);
  expect(engine.isGamePaused()).toBe(false);

  engine.removePlayer('peer-b');

  expect(engine.isGamePaused()).toBe(false);
  expect(engine.getPlayerCount()).toBe(1);
  expect(
    engine
      .getAllAsteroids()
      .map((asteroid) => asteroid.id)
      .sort((left, right) => left.localeCompare(right))
  ).toEqual(idsBefore);

  engine.removePlayer('peer-a');
  expect(engine.isGamePaused()).toBe(true);
  expect(
    engine
      .getAllAsteroids()
      .map((asteroid) => asteroid.id)
      .sort((left, right) => left.localeCompare(right))
  ).toEqual(idsBefore);
});

test('a stripped active field does not refill within the next frame', () => {
  const engine = new GameEngine(7);
  const player = engine.addPlayer('pilot', 'Pilot', new RecordingSocket(), { x: 0, y: 0 });
  const firstField = engine.getAllAsteroids();

  expect(player.type).toBe('player');
  expect(firstField.length).toBeGreaterThan(0);
  expect(engine.isGamePaused()).toBe(false);

  for (const asteroid of firstField) {
    engine.asteroidLifecycle.remove(asteroid.id);
  }
  expect(engine.getAsteroidCount()).toBe(0);

  // No reconnect or new player is involved, and no regrowth interval elapses.
  engine.advanceOneFrame();
  const secondField = engine.getAllAsteroids();
  expect(secondField).toEqual([]);

  engine.removePlayer('pilot');
  engine.stopGameLoop();
});

test('a stripped field does not refill across the last departure and an immediate rejoin', () => {
  const engine = new GameEngine(731);
  try {
    engine.updatePauseState();
    expect(engine.isGamePaused()).toBe(true);
    const initial = structuredClone(engine.createAsteroids(5));
    expect(initial).toHaveLength(5);
    engine.updatePauseState();
    engine.advanceOneFrame();
    expect(engine.getAllAsteroids()).toEqual(initial);

    engine.addPlayer('pilot', 'Pilot', new RecordingSocket());
    expect(engine.isGamePaused()).toBe(false);
    const joinedField = engine.getAllAsteroids();
    expect(joinedField.map((rock) => rock.id)).toEqual(initial.map((rock) => rock.id));
    expect(joinedField.some((rock) => rock.phenomenon?.kind === 'reflective')).toBe(true);

    for (const rock of initial) {
      engine.asteroidLifecycle.remove(rock.id);
    }
    expect(engine.getAllAsteroids()).toEqual([]);

    expect(engine.removePlayer('pilot')?.id).toBe('pilot');
    expect(engine.isGamePaused()).toBe(true);
    expect(engine.getAllAsteroids()).toEqual([]);

    engine.addPlayer('returning-pilot', 'Returning Pilot', new RecordingSocket());
    expect(engine.isGamePaused()).toBe(false);
    expect(engine.getAllAsteroids()).toEqual([]);
  } finally {
    engine.stopGameLoop();
  }
});
