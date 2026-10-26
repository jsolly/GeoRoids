/* @vitest-environment node */
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test, vi } from 'vitest';
import { WebSocketCore } from '../../../server/communication/WebSocketCore';
import { GameEngine } from '../../../server/core/GameEngine';
import { ServerClock } from '../../../server/core/ServerClock';
import {
  legacyWorldDigest,
  migrateCooperativeWorld,
} from '../../../server/world/cooperativeSchema';
import { InlineWorldPersistence } from '../../../server/world/InlineWorldPersistence';
import { WorldStore } from '../../../server/world/WorldStore';
import { logger } from '../../../setup/serverLogger';
import { checkBoundaryCollision } from '../../../shared/boundary';
import { hullRadiusForKit } from '../../../shared/shipKits';
import { SNAPSHOT_VERSION } from '../../../shared/snapshotProtocol';
import { WORLD } from '../../../shared/world';
import { RecordingSocket } from '../../support/recordingSocket';

/** An engine whose saved world has the cooperative campaign activated. */
function activatedEngine(): { engine: GameEngine; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'wall-cooperative-'));
  const path = join(dir, 'world.sqlite');
  new WorldStore(path).close();
  const db = new DatabaseSync(path);
  migrateCooperativeWorld(db, legacyWorldDigest(db));
  db.exec('UPDATE cooperative_schema SET activated=1');
  db.close();
  const store = new WorldStore(path);
  let elapsed = 0;
  const clock = new ServerClock({ wallNow: () => 0, monotonicNow: () => elapsed });
  const engine = new GameEngine(4242, clock, new InlineWorldPersistence(store));
  return {
    engine,
    cleanup: () => {
      elapsed = 0;
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('a cooperative wall death is recorded as gameplay, not as a movement violation', () => {
  const { engine, cleanup } = activatedEngine();
  const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  try {
    const wsCore = new WebSocketCore(engine);
    const novaWs = new RecordingSocket();
    const radius = hullRadiusForKit('scout');
    const rim = { x: WORLD.radius - radius, y: 0 };
    wsCore.handleClientMessage(
      {
        type: 'join',
        data: {
          id: 'nova',
          name: 'Nova',
          kitId: 'scout',
          position: rim,
          snapshotVersion: SNAPSHOT_VERSION,
          asteroidInteractions: 1,
          // An activated campaign refuses a join that does not declare it.
          cooperativeVersion: 1,
        },
      },
      novaWs
    );
    const joined = engine.getPlayerBySocket(novaWs);
    assert.ok(joined);
    joined.position = { ...rim };
    engine.entityManager.updateEntity(joined.id, { spawnProtectionTimer: 0 });
    const now = engine.getServerTime();
    assert.ok(engine.playerMotion.placeActorForTesting(joined.id, rim, now));
    const parked = engine.getPlayer(joined.id);
    assert.ok(parked?.playerMotion);
    const outward = engine.playerMotion.legalSpeed(parked, now) * 0.9;
    const overlapping = { x: rim.x + outward, y: 0 };
    expect(checkBoundaryCollision(overlapping, radius)).toBe(true);

    wsCore.handleClientMessage(
      {
        type: 'update',
        id: joined.id,
        data: {
          position: overlapping,
          velocity: { x: outward, y: 0 },
          angle: 0,
          thrusting: true,
          motionEpoch: parked.playerMotion.epoch,
          motionSequence: parked.playerMotion.ack + 1,
        },
      },
      novaWs
    );

    // Cooperative play routes a hull reaching zero health into a rescue window
    // rather than destroying it, so `handleShipDamage` reports
    // `isDestroyed: false`. The contact still ended this life, so it must not
    // spend the rejection warning's five-second per-socket window — reading the
    // destroyed flag alone would log every wall death in the mode this game is
    // normally played in as a movement-envelope violation.
    const downed = engine.getPlayer(joined.id);
    expect(downed?.health).toBe(0);
    expect(downed?.downedUntil).toBeGreaterThan(0);
    expect(warn.mock.calls.map(([, event]) => event)).not.toContain('motion_command_rejected');
  } finally {
    warn.mockRestore();
    cleanup();
  }
});
