/* @vitest-environment node */
import { performance as nodePerformance } from 'node:perf_hooks';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { GameEngine, HUMAN_LASER_MAX_LIFETIME_MS } from '../../../server/core/GameEngine';
import { ServerClock } from '../../../server/core/ServerClock';
import { ASTEROID_MOTION } from '../../../shared/asteroidMotion';
import type { AsteroidData } from '../../../shared-types';
import { ROID } from '../../../src/constants';

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
    const player = engine.addPlayer(
      'pilot',
      'Pilot',
      socket,
      { x: 0, y: 0 },
      undefined,
      undefined,
      'ion'
    );
    player.asteroidInteractions = 1;
    const registered = engine.asteroidMotion.register(player, socket, 1, Date.now());
    expect(registered.ok).toBe(true);

    engine.advanceOneFrame();
    expect(engine.transportClosed(socket)).toBe(true);

    const beforeElapsed = engine.getServerTime();
    advanceElapsed(ASTEROID_MOTION.reconnectGraceMs + 20);
    expect(engine.getServerTime()).toBe(beforeElapsed + ASTEROID_MOTION.reconnectGraceMs + 20);
    vi.setSystemTime(9_999);
    expect(() => engine.advanceOneFrame()).not.toThrow();
    expect(engine.getPlayer('pilot')).toBeUndefined();
  });

  test('stale cleanup follows elapsed time after a wall rollback', () => {
    const socket = {} as WebSocket;
    engine.addPlayer('pilot', 'Pilot', socket, { x: 0, y: 0 });

    advanceElapsed(30_001);
    vi.setSystemTime(9_999);
    expect(engine.entityManager.cleanupStaleEntities()).toEqual(['pilot']);
  });

  test('rejoin stash expiry follows elapsed time after a wall rollback', () => {
    const socket = {} as WebSocket;
    const player = engine.addPlayer('pilot', 'Pilot', socket, { x: 0, y: 0 });
    player.lives = 2;
    player.score = 17;
    expect(engine.removePlayer('pilot')).toBeDefined();

    advanceElapsed(5 * 60 * 1000 + 1);
    vi.setSystemTime(9_999);
    const rejoined = engine.addPlayer('pilot', 'Pilot', {} as WebSocket, { x: 0, y: 0 });
    expect(rejoined.lives).toBe(3);
    expect(rejoined.score).toBe(0);
  });

  test('human laser expiry follows elapsed time after a wall rollback', () => {
    const socket = {} as WebSocket;
    const pilot = engine.addPlayer('pilot', 'Pilot', socket, { x: 0, y: 0 });
    for (const asteroid of engine.getAllAsteroids()) {
      engine.removeAsteroid(asteroid.id);
    }

    const laser = engine.spawnHumanLaser(pilot.id, pilot.position, { x: 0, y: 0 });
    expect(laser).not.toBeNull();
    expect(engine.getServerLasers()).toHaveLength(1);

    advanceElapsed(HUMAN_LASER_MAX_LIFETIME_MS + 1);
    vi.setSystemTime(9_999);
    expect(engine.advanceLasersAndResolveHits()).toEqual([]);
    expect(engine.getServerLasers()).toHaveLength(0);
  });

  test('collaborative asteroid expiry follows elapsed time after a wall rollback', () => {
    const socket = {} as WebSocket;
    const pilot = engine.addPlayer('pilot', 'Pilot', socket, { x: 0, y: 0 });
    const target: AsteroidData = {
      id: 'clock-collab-target',
      position: { x: 400, y: 300 },
      velocity: { x: 0, y: 0 },
      size: 50,
      jaggedness: 0.5,
      rotation: 0,
      angularVelocity: 0,
      health: 50,
      maxHealth: 50,
      vertices: 8,
      offsets: [1, 1, 1, 1, 1, 1, 1, 1],
      material: 'ice',
    };
    engine.addAsteroid(target);

    const firstHit = engine.applyLaserAsteroidHit(target.id, pilot.id);
    expect(firstHit.outcome).toBe('tagged');
    expect(engine.getActiveCollabTags()).toHaveLength(1);

    advanceElapsed(ROID.COLLAB_SPLIT_WINDOW_MS + 1);
    vi.setSystemTime(9_999);
    expect(engine.flushExpiredCollabHits()).toHaveLength(1);
    expect(engine.getAsteroid(target.id)).toBeUndefined();
  });

  test('explicit simulation times reject invalid or backwards values while allowing repeats', () => {
    for (const invalid of [Number.NaN, -1, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() => engine.stepClock(invalid)).toThrow(RangeError);
      expect(() => engine.advanceOneFrame(invalid)).toThrow(RangeError);
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
