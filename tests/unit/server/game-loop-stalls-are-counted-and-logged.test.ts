/* @vitest-environment node */
import { afterEach, expect, test, vi } from 'vitest';
import { GameEngine } from '../../../server/core/GameEngine';
import { ServerClock } from '../../../server/core/ServerClock';
import { logger } from '../../../setup/serverLogger';
import { GAME_TICK_MS, MAX_CATCH_UP_TICKS } from '../../../shared/gameClock';
import { RecordingSocket } from '../../support/recordingSocket';

afterEach(() => {
  vi.restoreAllMocks();
});

test('a clock step that arrives seconds late is counted on /health and logged once per window', () => {
  const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  let elapsed = 0;
  const clock = new ServerClock({ wallNow: () => 10_000, monotonicNow: () => elapsed });
  const engine = new GameEngine(17, clock);
  try {
    const pilot = engine.addPlayer('pilot', 'Pilot', new RecordingSocket(), { x: 0, y: 0 });
    pilot.asteroidInteractions = 1;
    for (const rock of engine.getAllAsteroids()) {
      engine.removeAsteroid(rock.id);
    }
    expect(engine.stepClock()).toBe(0);
    expect(engine.getDiagnostics().loop).toEqual({
      discardedDebtMs: 0,
      longestStallMs: 0,
      stalls: 0,
    });
    const stalled = () =>
      warn.mock.calls.filter(
        ([category, event]) => category === 'STATE' && event === 'game_loop_stalled'
      );

    // Ordinary ticks, even a little late, are not stalls.
    for (let tick = 0; tick < 30; tick++) {
      elapsed += GAME_TICK_MS + 4;
      engine.stepClock();
    }
    expect(engine.getDiagnostics().loop).toMatchObject({ discardedDebtMs: 0, stalls: 0 });
    expect(stalled()).toEqual([]);

    // The loop is blocked for 1.6 s: one second is replayed, the rest is
    // discarded, and operators get one searchable line for it.
    elapsed += 1_600;
    expect(engine.stepClock()).toBe(MAX_CATCH_UP_TICKS);
    const afterStall = engine.getDiagnostics().loop;
    expect(afterStall.stalls).toBe(1);
    expect(afterStall.discardedDebtMs).toBeGreaterThan(550);
    expect(afterStall.discardedDebtMs).toBeLessThan(650);
    expect(afterStall.longestStallMs).toBeGreaterThan(1_500);
    expect(stalled()).toHaveLength(1);
    expect(stalled()[0]?.[2]).toMatchObject({ players: 1, catchupTicks: MAX_CATCH_UP_TICKS });
    const logged = stalled()[0]?.[2] as { blockedMs: number; discardedMs: number };
    expect(logged.blockedMs).toBeGreaterThan(1_500);
    expect(logged.discardedMs).toBeGreaterThan(550);

    // A second stall inside the same five seconds is counted but not logged again.
    elapsed += 400;
    engine.stepClock();
    expect(engine.getDiagnostics().loop.stalls).toBe(2);
    expect(engine.getDiagnostics().loop.longestStallMs).toBe(afterStall.longestStallMs);
    expect(stalled()).toHaveLength(1);
  } finally {
    engine.stopGameLoop();
  }
});
