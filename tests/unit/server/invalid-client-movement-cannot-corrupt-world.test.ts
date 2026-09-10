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
  { label: 'null legacy rotation', movement: { rotation: null } },
  { label: 'non-finite legacy angular velocity', movement: { a: Number.NEGATIVE_INFINITY } },
  { label: 'non-boolean thrust', movement: { thrusting: 'true' } },
];

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
      core.handleClientMessage({ type: 'join', data: { id: 'pilot', name: 'Pilot' } }, owner);
      core.handleClientMessage({ type: 'join', data: { id: 'peer', name: 'Peer' } }, peer);
      const pilot = engine.getPlayer('pilot');
      assert.ok(pilot, 'movement pilot');
      delete pilot.spawnProtectionTimer;
      expect(engine.handlePlayerDamage(pilot.id, 'boundary', pilot.maxHealth)).toBe(true);
      for (let frame = 0; frame <= SHIP.RESPAWN_DELAY_FRAMES && pilot.health <= 0; frame++) {
        engine.advanceCombatFrame();
      }
      expect(pilot.health).toBe(pilot.maxHealth);
      expect(pilot.respawnAnchor).toBeDefined();
      const position = { ...pilot.position };
      const velocity = { ...pilot.velocity };
      const anchor = pilot.respawnAnchor;
      assert.ok(anchor, 'respawn anchor');
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
      expect(pilot.respawnAnchor).toEqual(anchor);
      const activeEngine = engine;
      assert.ok(activeEngine, 'movement engine');
      expect(() => activeEngine.advanceOneFrame()).not.toThrow();

      // Rejection is atomic and does not break the socket's next legitimate
      // pose acknowledgment or input. Legacy angular-velocity alias stays valid.
      const nextPosition = { x: position.x + 5, y: position.y + 5 };
      core.handleClientMessage(
        {
          type: 'update',
          id: pilot.id,
          data: {
            position: nextPosition,
            velocity: { x: 1, y: 2 },
            angle: 0.25,
            a: 0.5,
            thrusting: true,
          },
        },
        owner
      );
      expect(pilot.position).toEqual(nextPosition);
      expect(pilot.velocity).toEqual({ x: 1, y: 2 });
      expect(pilot.angle).toBe(0.25);
      expect(pilot.thrusting).toBe(true);
      expect(pilot.respawnAnchor).toBeUndefined();
      const accepted = peer.inbox.find((message) => message.type === 'playerUpdate');
      expect(accepted?.data).toMatchObject({
        position: nextPosition,
        angularVelocity: 0.5,
        thrusting: true,
      });
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
    core.handleClientMessage(
      { type: 'join', data: { id: 'pilot', name: 'Pilot', kitId: 'hauler' } },
      owner
    );
    core.handleClientMessage({ type: 'join', data: { id: 'peer', name: 'Peer' } }, peer);
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
    const position = JSON.parse('{"x":100,"y":200,"__proto__":{"poison":true},"extra":null}');
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
    expect(pilot.position).toEqual({ x: 100, y: 200 });
    expect(pilot.velocity).toEqual({ x: 1, y: 2 });
    expect(pilot).not.toHaveProperty('futureServerField');
    expect(Object.getPrototypeOf(pilot)).toBe(Object.prototype);
    const accepted = peer.inbox.find((message) => message.type === 'playerUpdate');
    expect(accepted?.data).toEqual({
      id: pilot.id,
      position: { x: 100, y: 200 },
      velocity: { x: 1, y: 2 },
      angle: 0.5,
      rotation: 0.5,
      thrusting: false,
    });
    expect(engine.getPlayerBySocket(owner)).toBe(pilot);
  });
});
