import { expect, test } from 'vitest';
import { GameEngine } from '../../../server/core/GameEngine';
import { RecordingSocket } from '../../support/recordingSocket';

test('a depleted field stays empty across the last departure and the next join', () => {
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
    expect(engine.getAllAsteroids()).toEqual(initial);

    for (const rock of initial) {
      engine.removeAsteroid(rock.id);
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
