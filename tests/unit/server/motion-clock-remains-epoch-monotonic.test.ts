/* @vitest-environment node */
import { performance as nodePerformance } from 'node:perf_hooks';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { GameEngine, PLAYER_LASER_MAX_LIFETIME_MS } from '../../../server/core/GameEngine';
import { ServerClock } from '../../../server/core/ServerClock';
import { PLAYER_MOTION } from '../../../shared/playerMotion';

describe('server motion clock', () => {
  let engine: GameEngine;
  let monotonicNowMs = 0;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    monotonicNowMs = 1_000;
    vi.spyOn(nodePerformance, 'now').mockImplementation(() => monotonicNowMs);
    engine = new GameEngine(17);
  });

  afterEach(() => {
    engine.stopGameLoop();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function advanceElapsed(ms: number): void {
    monotonicNowMs += ms;
    vi.advanceTimersByTime(ms);
  }

  test('a wall-clock rollback cannot stop an active session grace deadline', () => {
    const socket = {} as WebSocket;
    const player = engine.addPlayer('pilot', 'Pilot', socket, { x: 0, y: 0 }, undefined);
    player.asteroidInteractions = 1;
    const registered = engine.playerMotion.register(player, socket, 1, Date.now());
    expect(registered.ok).toBe(true);

    engine.advanceOneFrame();
    expect(engine.transportClosed(socket)).toBe(true);

    const beforeElapsed = engine.getServerTime();
    advanceElapsed(PLAYER_MOTION.reconnectGraceMs + 20);
    expect(engine.getServerTime()).toBe(beforeElapsed + PLAYER_MOTION.reconnectGraceMs + 20);
    vi.setSystemTime(9_999);
    expect(() => engine.advanceOneFrame()).not.toThrow();
    expect(engine.getPlayer('pilot')).toBeUndefined();
  });

  test('stale cleanup follows elapsed time after a wall rollback', () => {
    const socket = {} as WebSocket;
    engine.addPlayer('pilot', 'Pilot', socket, { x: 0, y: 0 });

    advanceElapsed(30_001);
    vi.setSystemTime(9_999);
    expect(engine.entityManager.getStalePlayerIds()).toEqual(['pilot']);
  });

  test('player laser expiry follows elapsed time after a wall rollback', () => {
    const socket = {} as WebSocket;
    const pilot = engine.addPlayer('pilot', 'Pilot', socket, { x: 0, y: 0 });
    for (const asteroid of engine.getAllAsteroids()) {
      engine.removeAsteroid(asteroid.id);
    }

    const laser = engine.spawnPlayerLaser(pilot.id, pilot.position, { x: 0, y: 0 });
    expect(laser).not.toBeNull();
    expect(engine.getServerLasers()).toHaveLength(1);

    advanceElapsed(PLAYER_LASER_MAX_LIFETIME_MS + 1);
    vi.setSystemTime(9_999);
    expect(engine.advanceLasersAndResolveHits()).toEqual([]);
    expect(engine.getServerLasers()).toHaveLength(0);
  });

  test('explicit simulation times reject invalid or backwards values while allowing repeats', () => {
    const invalidTimes = [Number.NaN, -1, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];
    const expectInvalidClock = (invalid: number) => {
      expect(() => engine.stepClock(invalid)).toThrow(RangeError);
      expect(() => engine.advanceOneFrame(invalid)).toThrow(RangeError);
    };
    for (const invalid of invalidTimes) {
      expectInvalidClock(invalid);
    }

    expect(engine.stepClock(100)).toBe(0);
    expect(engine.stepClock(100)).toBe(0);
    expect(() => engine.stepClock(99)).toThrow(RangeError);
    expect(() => engine.advanceOneFrame(99)).toThrow(RangeError);
    expect(() => engine.advanceOneFrame(100)).not.toThrow();
    expect(() => engine.advanceOneFrame(100)).not.toThrow();
  });

  test('the clock fails closed if its monotonic source moves backwards', () => {
    let monotonicNow = 100;
    const clock = new ServerClock({
      wallNow: () => 10_000,
      monotonicNow: () => monotonicNow,
    });

    expect(clock.now()).toBe(10_000);
    monotonicNow = 200;
    expect(clock.now()).toBe(10_100);
    monotonicNow = 150;
    expect(() => clock.now()).toThrow(RangeError);
  });
});
