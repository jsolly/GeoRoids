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
    const registered = engine.pilotSessions.register({ actor: actor, socket: socket });
    assert(registered.ok);
    actor.score = 1200;
    actor.spawnProtectionTimer = 0;
    engine.useAbility(actor.id);
    const revealed = engine.getGameState().exploration;
    expect(engine.handleShipDamage(actor.id, 'asteroid', actor.health).isDestroyed).toBe(true);
    expect(actor.score).toBe(1200);

    const continued = engine.pilotSessions.resume({
      token: registered.resumeToken,
      socket: new RecordingSocket(),
      requestedKit: undefined,
      requestedName: 'Bob',
    });
    assert(continued.ok);
    expect(continued.actor.score).toBe(1200);
    expect(continued.actor.name).toBe('Bob');
    expect(continued.actor.health).toBe(0);
    expect(continued.actor.respawnTimer).toBeGreaterThan(0);

    // A graceful restart flushes the new credential before the database is reopened.
    engine.checkpointWorld();
    const restarted = new GameEngine(0, undefined, new InlineWorldPersistence(store));
    const resumed = restarted.pilotSessions.resume({
      token: continued.resumeToken,
      socket: new RecordingSocket(),
    });
    assert(resumed.ok);
    expect(resumed.actor.score).toBe(1200);
    expect(resumed.actor.health).toBe(0);
    expect(resumed.actor.respawnTimer).toBeGreaterThan(0);
    expect(restarted.getGameState().exploration).toEqual(revealed);
  } finally {
    store.close();
  }
});
