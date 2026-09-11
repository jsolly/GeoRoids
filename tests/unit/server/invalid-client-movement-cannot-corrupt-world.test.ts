/* @vitest-environment node */
import { strict as assert } from 'node:assert';
import { afterEach, describe, expect, test } from 'vitest';
import { WebSocketCore } from '../../../server/communication/WebSocketCore';
import { GameEngine } from '../../../server/core/GameEngine';
import { SHIP } from '../../../src/constants';
import { RecordingSocket } from '../../support/recordingSocket';

const invalidMovements: Array<{ label: string; movement: Record<string, unknown> }> = [
  { label: 'null position', movement: { position: null } },
  { label: 'position missing a coordinate', movement: { position: { x: 0 } } },
  { label: 'string position coordinate', movement: { position: { x: '0', y: 0 } } },
  { label: 'overflowed JSON coordinate', movement: { position: JSON.parse('{"x":1e400,"y":0}') } },
  { label: 'null velocity', movement: { velocity: null } },
  { label: 'non-finite velocity', movement: { velocity: { x: 0, y: Number.NaN } } },
  { label: 'non-finite angle', movement: { angle: Number.POSITIVE_INFINITY } },
  { label: 'non-finite angular velocity', movement: { angularVelocity: Number.NaN } },
  { label: 'non-boolean thrust', movement: { thrusting: 'true' } },
];

function join(core: WebSocketCore, socket: RecordingSocket, data: Record<string, unknown>): void {
  core.handleClientMessage(
    { type: 'join', data: { ...data, snapshotVersion: 1, asteroidInteractions: 1 } },
    socket
  );
}

describe('invalid client movement cannot corrupt the shared world', () => {
  let engine: GameEngine | undefined;

  afterEach(() => {
    engine?.stopGameLoop();
  });

  test.each(invalidMovements)(
    '$label is rejected before respawn acknowledgment or peer broadcast',
    ({ movement }) => {
      engine = new GameEngine(482);
      const core = new WebSocketCore(engine);
      const owner = new RecordingSocket();
      const peer = new RecordingSocket();
      join(core, owner, { id: 'pilot', name: 'Pilot' });
      join(core, peer, { id: 'peer', name: 'Peer' });
      const pilot = engine.getPlayer('pilot');
      assert.ok(pilot, 'movement pilot');
      delete pilot.spawnProtectionTimer;
      expect(engine.handlePlayerDamage(pilot.id, 'boundary', pilot.maxHealth)).toBe(true);
      for (let frame = 0; frame <= SHIP.RESPAWN_DELAY_FRAMES && pilot.health <= 0; frame++) {
        engine.advanceOneFrame();
      }
      expect(pilot.health).toBe(pilot.maxHealth);
      expect(pilot.playerMotion?.mode).toBe('handoff');
      const position = { ...pilot.position };
      const velocity = { ...pilot.velocity };
      const motion = structuredClone(pilot.playerMotion);
      assert.ok(motion, 'respawn motion state');
      const angle = pilot.angle;
      owner.clear();
      peer.clear();

      core.handleClientMessage(
        {
          type: 'update',
          id: pilot.id,
          data: { position, velocity: { x: 3, y: 4 }, angle: 0.75, thrusting: true, ...movement },
        },
        owner
      );

      expect(owner.inbox.some((message) => message.type === 'error')).toBe(true);
      expect(peer.inbox.some((message) => message.type === 'playerUpdate')).toBe(false);
      expect(pilot.position).toEqual(position);
      expect(pilot.velocity).toEqual(velocity);
      expect(pilot.angle).toBe(angle);
      expect(pilot.playerMotion).toEqual(motion);
      const activeEngine = engine;
      assert.ok(activeEngine, 'movement engine');
      expect(() => activeEngine.advanceOneFrame()).not.toThrow();

      // Rejection is atomic and does not break the socket's next legitimate
      // pose acknowledgment or input.
      const nextPosition = { x: pilot.position.x + 1, y: pilot.position.y + 1 };
      core.handleClientMessage(
        {
          type: 'update',
          id: pilot.id,
          data: {
            position: nextPosition,
            velocity: { x: 1, y: 2 },
            angle: 0.25,
            angularVelocity: 0.5,
            thrusting: true,
            motionEpoch: pilot.playerMotion?.epoch,
            motionSequence: 1,
          },
        },
        owner
      );
      expect(pilot.position).toEqual(nextPosition);
      expect(pilot.velocity).toEqual({ x: 1, y: 2 });
      expect(pilot.angle).toBe(0.25);
      expect(pilot.thrusting).toBe(true);
      expect(pilot.playerMotion).toMatchObject({ mode: 'free', ack: 1 });
      expect(peer.inbox.some((message) => message.type === 'playerUpdate')).toBe(false);
      expect(
        engine.getGameState().entities.find((entity) => entity.id === pilot.id)?.position
      ).toEqual(nextPosition);
    }
  );

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
    // The trusted entity API remains available to the authoritative ability
    // owner; the untrusted movement route may not rewrite its active endpoint.
    const latch = { ...rock.position };
    engine.updatePlayer(pilot.id, {
      harpoonTimer: 30,
      harpoonTargetId: rock.id,
      harpoonLatchPos: latch,
    });
    peer.clear();
    const position = JSON.parse('{"x":5,"y":5,"__proto__":{"poison":true},"extra":null}');
    const velocity = { x: 1, y: 2, unexpected: 'not public state' };
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
          harpoonTimer: 999,
          harpoonTargetId: 'missing',
          harpoonLatchPos: { x: null, y: 'bad' },
          lasers: [{ position: null }],
          futureServerField: { poisoned: true },
        },
      },
      owner
    );

    expect(pilot.ws).toBe(owner);
    expect(pilot.type).toBe('human');
    expect(pilot.name).toBe('Pilot');
    expect(pilot.harpoonTimer).toBe(30);
    expect(pilot.harpoonTargetId).toBe(rock.id);
    expect(pilot.harpoonLatchPos).toEqual(latch);
    expect(pilot.position).toEqual({ x: 5, y: 5 });
    expect(pilot.velocity).toEqual({ x: 1, y: 2 });
    expect(pilot).not.toHaveProperty('futureServerField');
    expect(Object.getPrototypeOf(pilot)).toBe(Object.prototype);
    expect(peer.inbox.some((message) => message.type === 'playerUpdate')).toBe(false);
    expect(engine.getPlayerBySocket(owner)).toBe(pilot);
  });
});
