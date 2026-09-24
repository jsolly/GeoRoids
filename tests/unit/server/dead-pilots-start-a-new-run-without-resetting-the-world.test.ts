/* @vitest-environment node */
import assert from 'node:assert/strict';
import { expect, test } from 'vitest';
import { GameEngine } from '../../../server/core/GameEngine';
import { InlineWorldPersistence } from '../../../server/world/InlineWorldPersistence';
import { WorldStore } from '../../../server/world/WorldStore';
import { RecordingSocket } from '../../support/recordingSocket';

test('a dead pilot resumes the countdown and preserves bank and exploration', () => {
  const store = new WorldStore(':memory:');
  try {
    const engine = new GameEngine(82, undefined, new InlineWorldPersistence(store));
    const socket = new RecordingSocket();
    const actor = engine.addPlayer('old-run', 'Pilot', socket, { x: 4000, y: 0 });
    actor.asteroidInteractions = 1;
    const registered = engine.registerPilot(actor, socket);
    assert(registered.ok);
    actor.score = 1200;
    actor.spawnProtectionTimer = 0;
    engine.useAbility(actor.id);
    const revealed = engine.getGameState().exploration;
    expect(engine.handleShipDamage(actor.id, 'asteroid', actor.health).isDestroyed).toBe(true);
    expect(actor.score).toBe(1200);

    const continued = engine.resumePilot(
      registered.resumeToken,
      new RecordingSocket(),
      undefined,
      'Bob'
    );
    assert(continued.ok);
    expect(continued.actor.score).toBe(1200);
    expect(continued.actor.name).toBe('Bob');
    expect(continued.actor.health).toBe(0);
    expect(continued.actor.respawnTimer).toBeGreaterThan(0);

    // A graceful restart flushes the new credential before the database is reopened.
    engine.checkpointWorld();
    const restarted = new GameEngine(0, undefined, new InlineWorldPersistence(store));
    const resumed = restarted.resumePilot(continued.resumeToken, new RecordingSocket());
    assert(resumed.ok);
    expect(resumed.actor.score).toBe(1200);
    expect(resumed.actor.health).toBe(0);
    expect(restarted.getGameState().exploration).toEqual(revealed);
  } finally {
    store.close();
  }
});
