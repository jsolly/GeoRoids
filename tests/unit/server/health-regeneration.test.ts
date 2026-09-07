/* @vitest-environment node */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { WebSocket } from 'ws';

import { WebSocketCore } from '../../../server/communication/WebSocketCore';
import { GameEngine } from '../../../server/core/GameEngine';
import {
  calculateHealthRegenDelayFrames,
  calculateHealthRegenPerFrame,
} from '../../../shared/constants/health';
import { DAMAGE, GAME, SHIP } from '../../../src/constants';

function tick(engine: GameEngine, frames: number): void {
  for (let frame = 0; frame < frames; frame++) {
    engine.advanceCombatFrame();
  }
}

describe('server-authoritative health regeneration', () => {
  let engine: GameEngine;

  beforeEach(() => {
    engine = new GameEngine(90210);
  });

  afterEach(() => {
    engine.stopGameLoop();
  });

  test('uses the ship tuning for one-frame rate and post-damage delay', () => {
    expect(calculateHealthRegenPerFrame()).toBe(SHIP.HEALTH_REGEN_RATE / GAME.FPS);
    expect(calculateHealthRegenDelayFrames()).toBe(
      Math.ceil(SHIP.HEALTH_REGEN_DELAY * GAME.FPS)
    );
  });

  test('human damage waits for the delay and then heals without exceeding max health', () => {
    const pilot = engine.addPlayer('pilot', 'Pilot', {} as WebSocket, { x: 0, y: 0 });
    pilot.spawnProtectionTimer = undefined;

    engine.handlePlayerDamage(pilot.id, 'asteroid', DAMAGE.LASER_HIT);
    expect(pilot.health).toBe(SHIP.MAX_HEALTH - DAMAGE.LASER_HIT);
    expect(pilot.healthRegenTimer).toBe(calculateHealthRegenDelayFrames());

    tick(engine, calculateHealthRegenDelayFrames());
    expect(pilot.health).toBe(SHIP.MAX_HEALTH - DAMAGE.LASER_HIT);

    tick(engine, 1);
    expect(pilot.health).toBeGreaterThan(SHIP.MAX_HEALTH - DAMAGE.LASER_HIT);

    pilot.health = pilot.maxHealth - calculateHealthRegenPerFrame() / 2;
    pilot.healthRegenTimer = 0;
    tick(engine, 1);
    expect(pilot.health).toBe(pilot.maxHealth);
  });

  test('a repeated hit resets the same regeneration timer', () => {
    const pilot = engine.addPlayer('pilot', 'Pilot', {} as WebSocket, { x: 0, y: 0 });
    pilot.spawnProtectionTimer = undefined;

    engine.handlePlayerDamage(pilot.id, 'asteroid', DAMAGE.LASER_HIT);
    tick(engine, calculateHealthRegenDelayFrames() - 1);
    const healthAfterFirstDelay = pilot.health;

    engine.handlePlayerDamage(pilot.id, 'asteroid', 1);
    expect(pilot.health).toBe(healthAfterFirstDelay - 1);
    expect(pilot.healthRegenTimer).toBe(calculateHealthRegenDelayFrames());

    tick(engine, calculateHealthRegenDelayFrames());
    expect(pilot.health).toBe(healthAfterFirstDelay - 1);
    tick(engine, 1);
    expect(pilot.health).toBeGreaterThan(healthAfterFirstDelay - 1);
  });

  test('dead ships never regenerate, and clients cannot clear the server timer', () => {
    const ws = {} as WebSocket;
    const core = new WebSocketCore(engine);
    const pilot = engine.addPlayer('pilot', 'Pilot', ws, { x: 0, y: 0 });
    pilot.spawnProtectionTimer = undefined;
    engine.handlePlayerDamage(pilot.id, 'asteroid', DAMAGE.LASER_HIT);
    const delay = pilot.healthRegenTimer;

    core.handleClientMessage(
      { type: 'update', id: pilot.id, data: { healthRegenTimer: 0 } },
      ws
    );
    expect(pilot.healthRegenTimer).toBe(delay);

    pilot.lives = 0;
    engine.handlePlayerDamage(pilot.id, 'asteroid', pilot.health);
    expect(pilot.health).toBe(0);
    tick(engine, calculateHealthRegenDelayFrames() + SHIP.EXPLODE_DURATION_FRAMES + 1);
    expect(pilot.health).toBe(0);
  });

  test('bots use the same delay and rate as humans', () => {
    engine.addPlayer('pilot', 'Pilot', {} as WebSocket, { x: 0, y: 0 });
    const bot = engine.createBots(1)?.[0];
    expect(bot).toBeDefined();
    bot!.spawnProtectionTimer = undefined;

    engine.handleBotDamage(bot!.id, 'asteroid', DAMAGE.LASER_HIT);
    const damagedHealth = bot!.health;
    tick(engine, calculateHealthRegenDelayFrames());
    expect(bot!.health).toBe(damagedHealth);

    tick(engine, 1);
    expect(bot!.health).toBeGreaterThan(damagedHealth);
    expect(bot!.health).toBeLessThanOrEqual(bot!.maxHealth);
  });
});
