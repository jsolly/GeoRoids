import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { GameEngine } from '../../../../server/core/GameEngine';
import { GAME_TICK_MS } from '../../../../shared/gameClock';
import type { AsteroidData } from '../../../../shared-types';
import { SHIP } from '../../../../src/constants';
import { RecordingSocket } from '../../../support/recordingSocket';

function motionAsteroid(): AsteroidData {
  return {
    id: 'motion-asteroid',
    position: { x: 0, y: 0 },
    velocity: { x: 0, y: 0 },
    size: 70,
    jaggedness: 0,
    rotation: Math.PI / 4,
    angularVelocity: 0.16,
    health: 100,
    maxHealth: 100,
    vertices: 4,
    offsets: [1, 1, 1, 1],
    material: 'metal',
    spinClass: 'natural',
  };
}

function attachedMotionWorld() {
  const world = new GameEngine(99);
  const socket = new RecordingSocket();
  const asteroid = motionAsteroid();
  world.addAsteroid(asteroid);
  const actor = world.addPlayer(
    'hauler',
    'Hauler',
    socket,
    { x: 100, y: 0 },
    undefined,
    'hauler',
    'ion'
  );
  actor.asteroidInteractions = 1;
  actor.spawnProtectionTimer = 0;
  actor.abilityCooldownFrames = 0;
  const registered = world.asteroidMotion.register(actor, socket, 1, 1000);
  if (!registered.ok) {
    throw new Error(registered.error);
  }
  const latched = world.asteroidMotion.latch(
    socket,
    { action: 'latch', targetId: asteroid.id, sequence: 0 },
    [asteroid],
    1000
  );
  if (!latched.ok) {
    throw new Error(latched.error);
  }
  return { world, actor, asteroid };
}

describe('Game clock catch-up after a hitch', () => {
  let engine: GameEngine;

  beforeEach(() => {
    engine = new GameEngine(99);
  });

  afterEach(() => {
    engine.stopGameLoop();
  });

  test('stepClock catches up missed frames instead of stalling at +1', () => {
    expect(engine.stepClock(0)).toBe(0);
    expect(engine.getDiagnostics().gameTime).toBe(0);

    expect(engine.stepClock(GAME_TICK_MS)).toBe(1);
    expect(engine.getDiagnostics().gameTime).toBe(1);

    const caught = engine.stepClock(GAME_TICK_MS + 500);
    expect(caught).toBe(30);
    expect(engine.getDiagnostics().gameTime).toBe(31);
  });

  test('a hitch during explode still finishes death→respawn in the catch-up', () => {
    const ws = new RecordingSocket();
    engine.addPlayer('p1', 'Pilot', ws, { x: 0, y: 0 });
    engine.entityManager.updateEntity('p1', { spawnProtectionTimer: 0 });
    engine.handlePlayerDamage('p1', 'boundary', 100);

    engine.stepClock(0);
    engine.stepClock(GAME_TICK_MS * SHIP.EXPLODE_DURATION_FRAMES);

    const ship = engine.getPlayer('p1');
    expect(ship?.health).toBe(ship?.maxHealth);
    expect(ship?.exploding).toBe(false);
    expect(ship?.respawnTimer).toBeUndefined();
    expect(ship?.spawnProtectionTimer).toBe(SHIP.INVINCIBILITY_DURATION_FRAMES);
    expect(engine.getDiagnostics().gameTime).toBe(SHIP.EXPLODE_DURATION_FRAMES);
  });

  test('a one-second hitch advances attached enhanced motion like 60 normal ticks', () => {
    let wallNow = 1000;
    const wallClock = vi.spyOn(Date, 'now').mockImplementation(() => wallNow);
    let normal: ReturnType<typeof attachedMotionWorld> | undefined;
    let hitch: ReturnType<typeof attachedMotionWorld> | undefined;
    try {
      normal = attachedMotionWorld();
      hitch = attachedMotionWorld();
      normal.world.stepClock(0);
      hitch.world.stepClock(0);
      const normalInitialRotation = normal.asteroid.rotation;
      const hitchInitialRotation = hitch.asteroid.rotation;

      let normalFrames = 0;
      for (let frame = 1; frame <= 60; frame += 1) {
        wallNow = 1000 + frame * GAME_TICK_MS;
        normalFrames += normal.world.stepClock(frame * GAME_TICK_MS);
      }

      expect(normalFrames).toBe(60);
      wallNow = 2000;
      expect(hitch.world.stepClock(GAME_TICK_MS * 60)).toBe(60);
      expect(hitch.world.getDiagnostics().gameTime).toBe(60);
      expect(normal.asteroid.rotation).toBeGreaterThan(normalInitialRotation);
      expect(hitch.asteroid.rotation).toBeGreaterThan(hitchInitialRotation);
      expect(hitch.asteroid.rotation).toBeCloseTo(normal.asteroid.rotation, 8);
      expect(hitch.actor.position.x).toBeCloseTo(normal.actor.position.x, 8);
      expect(hitch.actor.position.y).toBeCloseTo(normal.actor.position.y, 8);
      expect(hitch.actor.asteroidMotion).toMatchObject({ mode: 'latched' });
      expect(hitch.world.asteroidMotion.ownsAsteroidMotion(hitch.asteroid.id)).toBe(true);
    } finally {
      normal?.world.stopGameLoop();
      hitch?.world.stopGameLoop();
      wallClock.mockRestore();
    }
  });

  test('a multi-second stall is capped to one recovery burst and does not replay dropped debt', () => {
    engine.stepClock(1000);
    expect(engine.stepClock(6000)).toBe(60);
    expect(engine.getDiagnostics().gameTime).toBe(60);
    expect(engine.stepClock(6000 + GAME_TICK_MS)).toBe(1);
    expect(engine.getDiagnostics().gameTime).toBe(61);
  });

  test('a backward monotonic sample is ignored without moving the clock origin', () => {
    engine.stepClock(1000);
    expect(engine.stepClock(900)).toBe(0);
    expect(engine.getDiagnostics().gameTime).toBe(0);
    expect(engine.stepClock(1000 + GAME_TICK_MS)).toBe(1);
    expect(engine.getDiagnostics().gameTime).toBe(1);
  });

  test('gameTime keeps advancing while paused after the last player leaves', () => {
    const ws = new RecordingSocket();
    engine.addPlayer('p1', 'Pilot', ws);
    engine.stepClock(0);
    engine.stepClock(GAME_TICK_MS * 5);
    engine.removePlayer('p1');
    expect(engine.isGamePaused()).toBe(true);

    const before = engine.getDiagnostics().gameTime;
    engine.stepClock(GAME_TICK_MS * 5 + 200);
    expect(engine.getDiagnostics().gameTime).toBeGreaterThan(before);
  });
});
