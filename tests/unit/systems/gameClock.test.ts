import { describe, expect, test } from 'vitest';
import {
  consumeTickAccumulator,
  GAME_TICK_MS,
  MAX_CATCH_UP_TICKS,
  MAX_TICK_DEBT_MS,
  ticksForElapsed,
} from '../../../shared/gameClock';

describe('game clock', () => {
  test('a sub-frame delta is not a tick — 144 Hz must not burn explode counters', () => {
    expect(ticksForElapsed(GAME_TICK_MS * 0.4)).toBe(0);
  });

  test('one 60 Hz interval is one tick', () => {
    expect(ticksForElapsed(GAME_TICK_MS)).toBe(1);
    expect(ticksForElapsed(1000)).toBe(60);
  });

  test('a hitch catches up instead of stalling, but not without a cap', () => {
    expect(ticksForElapsed(500)).toBe(30);
    expect(ticksForElapsed(10_000)).toBe(MAX_CATCH_UP_TICKS);
  });

  test('accumulator leaves the leftover milliseconds for the next frame', () => {
    const { frames, remainingMs } = consumeTickAccumulator(GAME_TICK_MS * 2.5);
    expect(frames).toBe(2);
    expect(remainingMs).toBeCloseTo(GAME_TICK_MS * 0.5, 8);
  });

  test('bounded debt catches up a short stall and a one-second stall completely', () => {
    expect(consumeTickAccumulator(100).frames).toBe(6);
    expect(consumeTickAccumulator(1000).frames).toBe(MAX_CATCH_UP_TICKS);
    expect(consumeTickAccumulator(MAX_TICK_DEBT_MS).discardedMs).toBeCloseTo(0, 8);
  });

  test('a multi-second stall drops excess debt instead of replaying it forever', () => {
    const result = consumeTickAccumulator(5000);
    expect(result.frames).toBe(MAX_CATCH_UP_TICKS);
    expect(result.remainingMs).toBeCloseTo(0, 8);
    expect(result.discardedMs).toBeCloseTo(4000, 8);
  });
});
