import { strict as assert } from 'node:assert';
import { expect, test, vi } from 'vitest';
import { WebSocket } from 'ws';
import { createServerInstance } from '../../../server/createServer';
import {
  calculateHealthRegenDelayFrames,
  calculateHealthRegenPerFrame,
} from '../../../shared/constants/health';
import { SnapshotDecoder } from '../../../shared/snapshotProtocol';
import { DAMAGE, GAME, SHIP } from '../../../src/constants';
import { WireClient } from '../../support/wireClient';

test('both pilots see the same delayed health recovery after a hostile laser hit', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(10_000);
  const server = createServerInstance({ port: 0, nodeEnv: 'test' });
  const peers: WireClient[] = [];
  try {
    const port = await server.listening;
    const engine = server.gameEngine;
    engine.stopGameLoop();
    server.wsCore.stopPeriodicGameStateBroadcast();
    for (const [id, factionId] of [
      ['target', 'ion'],
      ['attacker', 'ember'],
    ]) {
      const peer = new WireClient(new WebSocket(`ws://127.0.0.1:${port}/ws`));
      peers.push(peer);
      await peer.open();
      peer.send({
        type: 'join',
        data: { id, name: id, factionId, snapshotVersion: 1, asteroidInteractions: 1 },
      });
      await peer.barrier();
      expect(peer.messages.some((message) => message.type === 'joined')).toBe(true);
    }
    const [targetPeer, attackerPeer] = peers;
    const target = engine.getPlayer('target');
    const attacker = engine.getPlayer('attacker');
    assert.ok(targetPeer && attackerPeer && target && attacker);
    Object.assign(target, { position: { x: 100, y: 0 }, spawnProtectionTimer: 0 });
    Object.assign(attacker, { position: { x: 0, y: 0 }, spawnProtectionTimer: 0 });
    // Only the projectile and combat clocks advance. Ambient simulation never runs.
    for (const asteroid of engine.getAllAsteroids()) {
      engine.updateAsteroid(asteroid.id, { position: { x: 1000, y: -1000 } });
    }
    for (const bot of engine.getAllBots()) {
      engine.removeBot(bot.id);
    }
    for (const row of engine.getAllSatellites()) {
      const satellite = engine.getSatellite(row.id);
      assert.ok(satellite);
      satellite.position = { x: 1000, y: 1000 };
    }
    const lives = target.lives;
    const maxHealth = target.maxHealth;
    expect(target.health).toBe(SHIP.MAX_HEALTH);
    const decoders = peers.map(() => ({ decoder: new SnapshotDecoder(), offset: 0 }));

    async function expectSharedHealth(health: number): Promise<void> {
      server.wsCore.getBroadcaster().broadcastGameState();
      for (const [index, peer] of peers.entries()) {
        await peer.barrier();
        const cursor = decoders[index];
        assert.ok(cursor);
        const frames = peer.messages
          .slice(cursor.offset)
          .filter((message) => message.type === 'snapshot');
        expect(frames.length).toBeGreaterThan(0);
        const snapshots = frames.map((message) => cursor.decoder.decode(message.data));
        cursor.offset = peer.messages.length;
        const snapshot = snapshots.at(-1);
        assert.ok(snapshot);
        const observed = snapshot.entities.find((entity) => entity.id === 'target');
        assert.ok(observed);
        expect(observed.health).toBeCloseTo(health, 8);
        expect(observed).toMatchObject({ lives, maxHealth, exploding: false });
        peer.assertHealthy();
      }
    }

    await expectSharedHealth(maxHealth);
    attackerPeer.send({
      type: 'shoot',
      data: { id: attacker.id, laserStart: { x: 20, y: 0 }, laserDirection: { x: 10, y: 0 } },
    });
    await attackerPeer.barrier();
    expect(engine.getPlayerProjectiles()).toHaveLength(1);
    for (let frame = 0; frame < 10; frame++) {
      engine.advanceLasersAndResolveHits();
    }
    expect(engine.getPlayerProjectiles()).toEqual([]);
    const damagedHealth = maxHealth - DAMAGE.LASER_HIT;
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
