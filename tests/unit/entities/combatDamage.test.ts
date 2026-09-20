import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { GameEngine } from '../../../server/core/GameEngine';
import { SHIP } from '../../../src/constants';
import { RecordingSocket } from '../../support/recordingSocket';

describe('Crew survival against world hazards', () => {
  let engine: GameEngine;

  beforeEach(() => {
    engine = new GameEngine(12345);
  });

  afterEach(() => {
    engine.stopGameLoop();
  });

  test('a ricochet damages a hull while a teammate laser still does not', () => {
    engine.addPlayer('p1', 'Pilot', new RecordingSocket(), { x: 0, y: 0 });
    engine.addPlayer('p2', 'Partner', new RecordingSocket(), { x: 40, y: 0 });
    engine.entityManager.updateEntity('p1', { spawnProtectionTimer: 0 });
    engine.entityManager.updateEntity('p2', { spawnProtectionTimer: 0 });

    expect(engine.handleShipDamage('p2', 'p1', 25).applied).toBe(false);
    expect(engine.getPlayer('p2')?.health).toBe(100);
    expect(engine.handleShipDamage('p2', 'ricochet', 25).applied).toBe(true);
    expect(engine.getPlayer('p2')?.health).toBe(75);
  });

  test('an overlay hold ignores world hazards and blinks only on return', () => {
    engine.addPlayer('p1', 'Pilot', new RecordingSocket(), { x: 0, y: 0 });
    engine.entityManager.updateEntity('p1', { spawnProtectionTimer: 0 });
    engine.setOverlayHold('p1', true);
    engine.setOverlayHold('p1', true);

    expect(engine.handleShipDamage('p1', 'asteroid', 25).applied).toBe(false);
    expect(engine.handleShipDamage('p1', 'ricochet', 25).applied).toBe(false);
    expect(engine.handleShipDamage('p1', 'boundary', 100).applied).toBe(false);
    expect(engine.getPlayer('p1')?.health).toBe(100);
    expect(engine.getPlayer('p1')?.overlayHold).toBe(true);

    engine.setOverlayHold('p1', false);
    expect(engine.getPlayer('p1')?.overlayHold).toBe(false);
    expect(engine.getPlayer('p1')?.spawnProtectionTimer).toBe(SHIP.INVINCIBILITY_DURATION_FRAMES);
    engine.entityManager.updateRespawns();
    const remaining = engine.getPlayer('p1')?.spawnProtectionTimer;
    expect(remaining).toBe(SHIP.INVINCIBILITY_DURATION_FRAMES - 1);
    engine.setOverlayHold('p1', false);
    engine.setOverlayHold('p1', false);
    expect(engine.getPlayer('p1')?.spawnProtectionTimer).toBe(remaining);
  });

  test('environmental damage destroys a player, spends a life, and schedules respawn', () => {
    engine.addPlayer('p1', 'Pilot', new RecordingSocket(), { x: 0, y: 0 });
    engine.entityManager.updateEntity('p1', { spawnProtectionTimer: 0 });

    const destroyed = engine.handleShipDamage('p1', 'asteroid', 100).isDestroyed;
    expect(destroyed).toBe(true);
    expect(engine.getPlayer('p1')?.lives).toBe(2);
    expect(engine.getPlayer('p1')?.respawnTimer).toBe(SHIP.RESPAWN_DELAY_FRAMES);
  });

  test('a boundary death preserves the pilot score', () => {
    engine.addPlayer('p1', 'Pilot', new RecordingSocket(), { x: 0, y: 0 });
    engine.entityManager.updateEntity('p1', { spawnProtectionTimer: 0 });

    expect(engine.handleShipDamage('p1', 'boundary', 100).isDestroyed).toBe(true);
    expect(engine.getPlayer('p1')?.score).toBe(0);
  });

  test('ignored hits during respawn keep health and score unchanged', () => {
    engine.addPlayer('p1', 'Pilot', new RecordingSocket(), { x: 0, y: 0 });
    engine.entityManager.updateEntity('p1', { spawnProtectionTimer: 0 });
    engine.handleShipDamage('p1', 'asteroid', 100);
    const afterDeath = engine.getPlayer('p1');
    expect(afterDeath?.respawnTimer).toBe(SHIP.RESPAWN_DELAY_FRAMES);

    expect(engine.handleShipDamage('p1', 'asteroid', 25).isDestroyed).toBe(false);
    expect(engine.getPlayer('p1')?.health).toBe(0);
    expect(engine.getPlayer('p1')?.score).toBe(0);
  });
});
