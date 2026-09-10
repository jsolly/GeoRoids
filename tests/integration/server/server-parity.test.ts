import { strict as assert } from 'node:assert';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { WebSocketCore } from '../../../server/communication/WebSocketCore';
import { GameEngine } from '../../../server/core/GameEngine';
import { RecordingSocket } from '../../support/recordingSocket';

describe('supported gameplay message envelopes', () => {
  let core: WebSocketCore;
  let engine: GameEngine;

  beforeEach(() => {
    engine = new GameEngine(731);
    core = new WebSocketCore(engine);
  });
  afterEach(() => {
    engine.stopGameLoop();
    core.stopPeriodicGameStateBroadcast();
  });

  test.each(['nested', 'top-level'] as const)(
    'a %s join receives its identity, rejects forged score, and owns a server projectile',
    (shape) => {
      const owner = new RecordingSocket();
      const peer = new RecordingSocket();
      const identity = {
        id: 'pilot',
        name: 'Pilot',
        position: { x: 0, y: 0 },
        snapshotVersion: 1,
        asteroidInteractions: 1,
      };
      core.handleClientMessage(
        shape === 'nested' ? { type: 'join', data: identity } : { type: 'join', ...identity },
        owner
      );
      expect(core.getPlayerCount()).toBe(1);
      expect(owner.lastReceived('joined')?.data).toMatchObject(identity);
      const pilot = engine.getPlayer(identity.id);
      assert.ok(pilot);
      expect(pilot.name).toBe(identity.name);

      core.handleClientMessage(
        {
          type: 'update',
          id: pilot.id,
          data: {
            position: { x: 1, y: 2 },
            velocity: { x: 0, y: 0 },
            angle: 0,
            thrusting: false,
            motionEpoch: pilot.asteroidMotion?.epoch,
            motionSequence: 0,
            score: 150,
          },
        },
        owner
      );
      expect(pilot.position).toEqual({ x: 1, y: 2 });
      expect(pilot.score).toBe(0);

      core.handleClientMessage(
        {
          type: 'join',
          data: {
            id: 'peer',
            name: 'Peer',
            position: { x: 1000, y: 1000 },
            snapshotVersion: 1,
            asteroidInteractions: 1,
          },
        },
        peer
      );
      for (const rock of engine.getAllAsteroids()) {
        engine.removeAsteroid(rock.id);
      }
      owner.clear();
      peer.clear();
      const shot = { laserStart: { x: 11, y: 2 }, laserDirection: { x: 1, y: 0 } };
      core.handleClientMessage({ type: 'shoot', id: pilot.id, data: shot }, owner);

      const [trackedShot] = engine.getPlayerProjectiles();
      assert.ok(trackedShot);
      expect(trackedShot.ownerId).toBe(pilot.id);
      expect(owner.received('playerShoot')).toEqual([]);
      expect(peer.received('playerShoot')).toEqual([]);
    }
  );

  test('an update without a player identity receives a timestamped error and changes no player', () => {
    const socket = new RecordingSocket();
    core.handleClientMessage({ type: 'update', data: { position: { x: 0, y: 0 } } }, socket);
    expect(socket.inbox).toEqual([
      { type: 'error', data: 'Missing player ID', timestamp: expect.any(Number) },
    ]);
    expect(core.getPlayerCount()).toBe(0);
  });
});
