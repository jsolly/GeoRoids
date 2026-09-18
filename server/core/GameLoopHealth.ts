import { logger } from '../../setup/serverLogger';
import { SERVER_RELEASE_ID } from '../release';
import type { WorldPersistenceDiagnostics } from '../world/worldPersistence';

/** A clock step this long could not read poses or serve clients; say so in the logs. */
const STALL_WARN_MS = 250;
const STALL_LOG_INTERVAL_MS = 5_000;

/** Always-on loop health for /health; cheap counters, not the opt-in profiler. */
export interface GameLoopHealthSnapshot {
  /** Simulation time dropped because a step was more than one second late. */
  discardedDebtMs: number;
  /** Longest single blocked stretch (late arrival plus catch-up) seen by the clock. */
  longestStallMs: number;
  /** Clock steps whose blocked stretch reached the stall warning threshold. */
  stalls: number;
}

/** One clock step as seen by the loop, in server time. */
interface ObservedClockStep {
  /** Late arrival plus catch-up: how long the loop could not read poses. */
  blockedMs: number;
  catchupTicks: number;
  discardedMs: number;
  now: number;
  gameTime: number;
  players: number;
  persistence: WorldPersistenceDiagnostics | undefined;
}

/**
 * Counts blocked clock steps and logs the first stall in every window, so
 * a blocked event loop shows up on /health and in Railway logs without the
 * profiler running.
 */
export class GameLoopHealth {
  private discardedDebtMs = 0;
  private longestStallMs = 0;
  private stalls = 0;
  private lastLoggedAtMs = Number.NEGATIVE_INFINITY;

  observe(step: ObservedClockStep): void {
    this.discardedDebtMs += step.discardedMs;
    if (step.blockedMs < STALL_WARN_MS) {
      return;
    }
    this.stalls++;
    this.longestStallMs = Math.max(this.longestStallMs, step.blockedMs);
    if (step.now - this.lastLoggedAtMs < STALL_LOG_INTERVAL_MS) {
      return;
    }
    this.lastLoggedAtMs = step.now;
    logger.warn('STATE', 'game_loop_stalled', {
      releaseId: SERVER_RELEASE_ID,
      observedAt: step.now,
      gameTime: step.gameTime,
      players: step.players,
      blockedMs: Math.round(step.blockedMs),
      catchupTicks: step.catchupTicks,
      discardedMs: Math.round(step.discardedMs),
      persistence: step.persistence,
    });
  }

  snapshot(): GameLoopHealthSnapshot {
    return {
      discardedDebtMs: this.discardedDebtMs,
      longestStallMs: this.longestStallMs,
      stalls: this.stalls,
    };
  }

  reset(): void {
    this.discardedDebtMs = 0;
    this.longestStallMs = 0;
    this.stalls = 0;
  }
}
