/* @vitest-environment node */
import assert from 'node:assert/strict';
import { expect, test } from 'vitest';
import { GameEngine } from '../../../server/core/GameEngine';
import { WorldStore } from '../../../server/world/WorldStore';
import { GAME } from '../../../src/constants';
import { RecordingSocket } from '../../support/recordingSocket';

test('a final-life death starts a new flight at score 0 and keeps crew exploration', () => {
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
    expect(actor.score).toBe(GAME.STARTING_SCORE);

    const continued = engine.resumePilot(
      registered.resumeToken,
      new RecordingSocket(),
      undefined,
      'Bob'
    );
    assert(continued.ok);
    expect(continued.actor.lives).toBe(3);
    expect(continued.actor.score).toBe(GAME.STARTING_SCORE);
    expect(continued.actor.name).toBe('Bob');
    expect(continued.actor.health).toBe(continued.actor.maxHealth);
    expect(continued.actor.position).not.toEqual({ x: 4000, y: 0 });
    expect(engine.resumePilot(registered.resumeToken, new RecordingSocket()).ok).toBe(false);

    const restarted = new GameEngine(0, undefined, store);
    const resumed = restarted.resumePilot(continued.resumeToken, new RecordingSocket());
    assert(resumed.ok);
    expect(resumed.actor.lives).toBe(3);
    expect(resumed.actor.score).toBe(GAME.STARTING_SCORE);
    expect(resumed.actor.health).toBe(resumed.actor.maxHealth);
    expect(restarted.getGameState().exploration).toEqual(revealed);
  } finally {
    store.close();
  }
});
