import { strict as assert } from 'node:assert';
import { expect, test, vi } from 'vitest';
import { WebSocket } from 'ws';
import { createServerInstance } from '../../../server/createServer';
import {
  calculateHealthRegenDelayFrames,
  calculateHealthRegenPerFrame,
} from '../../../shared/constants/health';
import { SnapshotDecoder } from '../../../shared/snapshotProtocol';
import type { ServerGameSnapshot } from '../../../shared-types';
import { DAMAGE, GAME, SHIP } from '../../../src/constants';
import { WireClient } from '../../support/wireClient';

test('both pilots see the same delayed health recovery after an asteroid impact', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(10_000);
  const server = createServerInstance({ port: 0, nodeEnv: 'test' });
  const peers: WireClient[] = [];
  try {
    const port = await server.listening;
    const engine = server.gameEngine;
    engine.stopGameLoop();
    server.wsCore.stopPeriodicGameStateBroadcast();
    for (const id of ['target', 'partner']) {
      const peer = new WireClient(
        new WebSocket(`ws://127.0.0.1:${port}/ws?asteroidInteractions=1`)
      );
      peers.push(peer);
      await peer.open();
      peer.send({
        type: 'join',
        data: { id, name: id, snapshotVersion: 1, asteroidInteractions: 1 },
      });
      await peer.barrier();
      expect(peer.messages.some((message) => message.type === 'joined')).toBe(true);
    }
    const [targetPeer, partnerPeer] = peers;
    const target = engine.getPlayer('target');
    const partner = engine.getPlayer('partner');
    assert.ok(targetPeer && partnerPeer && target && partner);
    Object.assign(target, { position: { x: 100, y: 0 }, spawnProtectionTimer: 0 });
    Object.assign(partner, { position: { x: 0, y: 0 }, spawnProtectionTimer: 0 });
    // Only the combat clock advances. Ambient simulation never runs.
    for (const asteroid of engine.getAllAsteroids()) {
      engine.updateAsteroid(asteroid.id, { position: { x: 1000, y: -1000 } });
    }
    engine.parkSatellitePickups({ x: 1000, y: 1000 });
    const maxHealth = target.maxHealth;
    expect(target.health).toBe(SHIP.MAX_HEALTH);
    const decoders = peers.map(() => ({ decoder: new SnapshotDecoder(), offset: 0 }));

    async function expectSharedHealth(health: number): Promise<void> {
      server.wsCore.getBroadcaster().broadcastGameState();
      for (const [index, peer] of peers.entries()) {
        await peer.barrier();
        const cursor = decoders[index];
        assert.ok(cursor);
        const snapshots: ServerGameSnapshot[] = [];
        for (const { raw } of peer.wireMessages.slice(cursor.offset)) {
          const result = cursor.decoder.readMessage(raw, { acceptSnapshots: true });
          if (result.kind === 'snapshot-rejected') {
            throw result.error;
          }
          if (result.kind === 'snapshot') {
            snapshots.push(result.state);
          } else if (
            result.message &&
            typeof result.message === 'object' &&
            'type' in result.message &&
            result.message.type === 'joined'
          ) {
            cursor.decoder.reset();
          }
        }
        expect(snapshots.length).toBeGreaterThan(0);
        cursor.offset = peer.wireMessages.length;
        const snapshot = snapshots.at(-1);
        assert.ok(snapshot);
        const observed = snapshot.entities.find((entity) => entity.id === 'target');
        assert.ok(observed);
        expect(observed.health).toBeCloseTo(health, 8);
        expect(observed).toMatchObject({ maxHealth, exploding: false });
        peer.assertHealthy();
      }
    }

    await expectSharedHealth(maxHealth);
    expect(engine.handleShipDamage(target.id, 'asteroid', DAMAGE.ASTEROID_COLLISION).applied).toBe(
      true
    );
    const damagedHealth = maxHealth - DAMAGE.ASTEROID_COLLISION;
    expect(target.health).toBe(damagedHealth);
    await expectSharedHealth(damagedHealth);

    const delay = calculateHealthRegenDelayFrames();
    for (let frame = 1; frame <= delay; frame++) {
      clock.mockReturnValue(10_000 + (frame * 1000) / GAME.FPS);
      engine.advanceCombatFrame();
    }
    await expectSharedHealth(damagedHealth);
    clock.mockReturnValue(10_000 + ((delay + 1) * 1000) / GAME.FPS);
    engine.advanceCombatFrame();
    const firstHealedHealth = damagedHealth + calculateHealthRegenPerFrame();
    expect(firstHealedHealth).toBeGreaterThan(damagedHealth);
    expect(firstHealedHealth).toBeLessThan(maxHealth);
    await expectSharedHealth(firstHealedHealth);
  } finally {
    clock.mockRestore();
    await server.close();
    for (const peer of peers) {
      peer.assertHealthy();
    }
  }
});
