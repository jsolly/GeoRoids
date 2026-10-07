/* @vitest-environment node */

import { strict as assert } from 'node:assert';
import { afterEach, describe, expect, test } from 'vitest';
import { WebSocketCore } from '../../../server/communication/WebSocketCore';
import { GameEngine } from '../../../server/core/GameEngine';
import { SNAPSHOT_VERSION } from '../../../shared/snapshotProtocol';
import { RecordingSocket } from '../../support/recordingSocket';

function join(core: WebSocketCore, socket: RecordingSocket, data: Record<string, unknown>): void {
  core.handleClientMessage(
    { type: 'join', data: { ...data, snapshotVersion: SNAPSHOT_VERSION, asteroidInteractions: 1 } },
    socket
  );
}

describe('invalid client movement cannot corrupt the shared world', () => {
  let engine: GameEngine | undefined;

  afterEach(() => {
    engine?.stopGameLoop();
  });

  test('movement cannot overwrite an active latch, socket, or inject unknown snapshot keys', () => {
    engine = new GameEngine(483);
    const core = new WebSocketCore(engine);
    const owner = new RecordingSocket();
    const peer = new RecordingSocket();
    join(core, owner, { id: 'pilot', name: 'Pilot', kitId: 'hauler' });
    join(core, peer, { id: 'peer', name: 'Peer' });
    const pilot = engine.getPlayer('pilot');
    assert.ok(pilot, 'latch pilot');
    const rock = engine.getAllAsteroids()[0];
    assert.ok(rock, 'latch asteroid');
    // Fresh flights arrive on the town ring. Park beside the pose this test
    // submits so the movement envelope accepts the sanitized coordinates.
    expect(
      engine.playerMotion.placeActorForTesting(pilot.id, { x: 5, y: 5 }, engine.getServerTime())
    ).toBe(true);
    // The trusted entity API remains available to the authoritative ability
    // owner; the untrusted movement route may not rewrite its active endpoint.
    const latch = { ...rock.position };
    engine.updatePlayer(pilot.id, {
      harpoonTargetId: rock.id,
      harpoonLatchPos: latch,
    });
    peer.clear();
    const position = JSON.parse('{"x":5,"y":5,"__proto__":{"poison":true},"extra":null}');
    const velocity = { x: 0.25, y: 0.5, unexpected: 'not public state' };
    const unknown = JSON.parse('{"__proto__":{"poison":true},"constructor":{"bad":true}}');
    core.handleClientMessage(
      {
        type: 'update',
        id: pilot.id,
        data: {
          ...unknown,
          position,
          velocity,
          angle: 0.5,
          thrusting: false,
          motionEpoch: pilot.playerMotion?.epoch,
          motionSequence: 1,
          ws: null,
          type: 'bot',
          name: 'Spoofed',
          socket: {},
          harpoonTargetId: 'missing',
          harpoonLatchPos: { x: null, y: 'bad' },
          angularVelocity: Number.NaN,
          lasers: [{ position: null }],
          futureServerField: { poisoned: true },
        },
      },
      owner
    );

    expect(pilot.ws).toBe(owner);
    expect(pilot.type).toBe('player');
    expect(pilot.name).toBe('Pilot');
    expect(pilot.harpoonTargetId).toBe(rock.id);
    expect(pilot.harpoonLatchPos).toEqual(latch);
    expect(pilot.position).toEqual({ x: 5, y: 5 });
    expect(pilot.velocity).toEqual({ x: 0.25, y: 0.5 });
    expect(pilot).not.toHaveProperty('futureServerField');
    expect(Object.getPrototypeOf(pilot)).toBe(Object.prototype);
    expect(peer.inbox.some((message) => message.type === 'playerUpdate')).toBe(false);
    expect(engine.getPlayerBySocket(owner)).toBe(pilot);
  });
});
