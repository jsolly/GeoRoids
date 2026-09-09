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

  test.each([
    'nested',
    'top-level',
  ] as const)('a %s join receives its identity, moves without forging score, and shares a shot with its peer', (shape) => {
    const owner = new RecordingSocket();
    const peer = new RecordingSocket();
    const identity = { id: 'pilot', name: 'Pilot', position: { x: 0, y: 0 } };
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
      { type: 'update', data: { id: pilot.id, position: { x: 100, y: 200 }, score: 150 } },
      owner
    );
    expect(pilot.position).toEqual({ x: 100, y: 200 });
    expect(pilot.score).toBe(0);

    core.handleClientMessage(
      { type: 'join', data: { id: 'peer', name: 'Peer', position: { x: 1000, y: 1000 } } },
      peer
    );
    for (const rock of engine.getAllAsteroids()) {
      engine.removeAsteroid(rock.id);
    }
    owner.clear();
    peer.clear();
    const shot = { laserStart: { x: 110, y: 200 }, laserDirection: { x: 1, y: 0 } };
    core.handleClientMessage({ type: 'shoot', id: pilot.id, data: shot }, owner);

    const [trackedShot] = engine.getPlayerProjectiles();
    assert.ok(trackedShot);
    expect(owner.received('playerShoot')).toEqual([]);
    expect(peer.received('playerShoot')).toEqual([
      {
        type: 'playerShoot',
        data: { id: pilot.id, shotId: trackedShot.id, ...shot },
        timestamp: expect.any(Number),
      },
    ]);
  });

  test('an update without a player identity receives a timestamped error and changes no player', () => {
    const socket = new RecordingSocket();
    core.handleClientMessage({ type: 'update', data: { position: { x: 0, y: 0 } } }, socket);
    expect(socket.inbox).toEqual([
      { type: 'error', data: 'Missing player ID', timestamp: expect.any(Number) },
    ]);
    expect(core.getPlayerCount()).toBe(0);
  });
});
