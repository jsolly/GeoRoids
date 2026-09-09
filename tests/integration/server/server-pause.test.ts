import { expect, test } from 'vitest';
import { GameEngine } from '../../../server/core/GameEngine';
import { RecordingSocket } from '../../support/recordingSocket';

test('a paused field survives the first join, then the last departure clears it for a fresh session', () => {
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

    expect(engine.removePlayer('pilot')?.id).toBe('pilot');
    expect(engine.isGamePaused()).toBe(true);
    expect(engine.getAllAsteroids()).toEqual([]);

    const fresh = engine.createAsteroids(10);
    expect(fresh).toHaveLength(10);
    expect(engine.getAsteroidCount()).toBe(10);
    const oldIds = new Set(initial.map((rock) => rock.id));
    expect(fresh.some((rock) => oldIds.has(rock.id))).toBe(false);
  } finally {
    engine.stopGameLoop();
  }
});
