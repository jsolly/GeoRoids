import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { WebSocket } from 'ws';
import { GameEngine } from '../../../../server/core/GameEngine';
import { GAME_TICK_MS } from '../../../../shared/gameClock';
import { SHIP } from '../../../../src/constants';

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
    const ws = {} as WebSocket;
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

  test('gameTime keeps advancing while paused after the last player leaves', () => {
    const ws = {} as WebSocket;
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
