import assert from 'node:assert/strict';
import { expect, test } from 'vitest';
import { GameEngine } from '../../../server/core/GameEngine';
import { WorldStore } from '../../../server/world/WorldStore';
import { RecordingSocket } from '../../support/recordingSocket';

test('a final-life death cannot resume in memory or after restart, and a new run preserves crew exploration', () => {
  const store = new WorldStore(':memory:');
  try {
    const engine = new GameEngine(82, undefined, store);
    const socket = new RecordingSocket();
    const actor = engine.addPlayer('old-run', 'Pilot', socket, { x: 4000, y: 0 });
    actor.asteroidInteractions = 1;
    const registered = engine.registerPilot(actor, socket);
    assert(registered.ok);
    actor.lives = 1;
    actor.score = 1200;
    actor.spawnProtectionTimer = 0;
    engine.useAbility(actor.id);
    const revealed = engine.getGameState().exploration;
    expect(engine.handleShipDamage(actor.id, 'asteroid', actor.health).isDestroyed).toBe(true);
    expect(actor.lives).toBe(0);
    expect(engine.resumePilot(registered.resumeToken, new RecordingSocket()).ok).toBe(false);
    expect(engine.getPlayer(actor.id)).toBeUndefined();

    const restarted = new GameEngine(0, undefined, store);
    expect(restarted.resumePilot(registered.resumeToken, new RecordingSocket()).ok).toBe(false);
    const fresh = restarted.addPlayer('new-run', 'Pilot', new RecordingSocket(), { x: 0, y: 0 });
    expect(fresh.lives).toBe(3);
    expect(fresh.score).toBe(0);
    expect(fresh.health).toBe(fresh.maxHealth);
    expect(restarted.getGameState().exploration).toEqual(revealed);
  } finally {
    store.close();
  }
});
