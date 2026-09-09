import { GAME } from '../src/constants';

/** One simulation frame at the authoritative 60 Hz tick. */
export const GAME_TICK_MS = 1000 / GAME.FPS;

/**
 * Cap catch-up after a hitch. 60 frames is one second — enough to finish
 * explode→respawn (18 frames) without spiraling if the event loop was blocked.
 */
export const MAX_CATCH_UP_TICKS = 60;

/**
 * Keep at most one second of simulation debt. A longer event-loop stall is
 * reported and the excess wall time is discarded instead of replaying an
 * unbounded burst of game frames over subsequent timer callbacks.
 */
export const MAX_TICK_DEBT_MS = MAX_CATCH_UP_TICKS * GAME_TICK_MS;

/**
 * How many 60 Hz frames elapsed wall-clock time represents.
 * Returns 0 for a sub-frame delta so a 144 Hz display does not burn
 * explosion / invuln counters faster than the server.
 */
export function ticksForElapsed(elapsedMs: number): number {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) {
    return 0;
  }
  return Math.min(MAX_CATCH_UP_TICKS, Math.floor(elapsedMs / GAME_TICK_MS + 1e-9));
}

/** Drain a millisecond accumulator into whole frames, leaving the remainder. */
export function consumeTickAccumulator(accumulatorMs: number): {
  frames: number;
  remainingMs: number;
  discardedMs: number;
} {
  if (!Number.isFinite(accumulatorMs) || accumulatorMs <= 0) {
    return { frames: 0, remainingMs: 0, discardedMs: 0 };
  }
  const boundedAccumulatorMs = Math.min(accumulatorMs, MAX_TICK_DEBT_MS);
  const frames = ticksForElapsed(boundedAccumulatorMs);
  const consumedMs = frames * GAME_TICK_MS;
  return {
    frames,
    remainingMs: Math.max(0, boundedAccumulatorMs - consumedMs),
    discardedMs: accumulatorMs - boundedAccumulatorMs,
  };
}
