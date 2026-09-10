/* @vitest-environment node */
import { strict as assert } from 'node:assert';
import { afterEach, describe, expect, test } from 'vitest';
import { WebSocketCore } from '../../../server/communication/WebSocketCore';
import { GameEngine } from '../../../server/core/GameEngine';
import { SHIP } from '../../../src/constants';
import { RecordingSocket } from '../../support/recordingSocket';

describe('late client death updates after authoritative respawn', () => {
  let engine: GameEngine | undefined;

  afterEach(() => {
    engine?.stopGameLoop();
  });

  test.each([
    { name: 'ordinary delayed exploding echo', extras: {} },
    {
      name: 'echo containing internal lifecycle fields',
      extras: {
        explodeTime: 999,
        deathCause: 'boundary',
        respawnAnchor: { x: 3150, y: 0 },
      },
    },
  ])('$name cannot poison the server or its peer update', ({ extras }) => {
    engine = new GameEngine(481);
    const core = new WebSocketCore(engine);
    const owner = new RecordingSocket();
    const peer = new RecordingSocket();
    core.handleClientMessage(
      {
        type: 'join',
        data: {
          id: 'pilot',
          name: 'Pilot',
          position: { x: 0, y: 0 },
          snapshotVersion: 1,
          asteroidInteractions: 1,
        },
      },
      owner
    );
    core.handleClientMessage(
      {
        type: 'join',
        data: {
          id: 'peer',
          name: 'Peer',
          position: { x: 1000, y: 0 },
          snapshotVersion: 1,
          asteroidInteractions: 1,
        },
      },
      peer
    );
    const pilot = engine.getPlayer('pilot');
    assert.ok(pilot, 'respawn pilot');
    pilot.position = { x: 3150, y: 0 };
    delete pilot.spawnProtectionTimer;
    pilot.score = 17;
    expect(engine.handlePlayerDamage(pilot.id, 'boundary', pilot.maxHealth)).toBe(true);
    expect(pilot.health).toBe(0);
    expect(pilot.lives).toBe(2);
    expect(pilot.exploding).toBe(true);

    // Drive the real authoritative lifecycle, without resetting its fields in
    // the fixture. The late packet arrives after respawn and pose adoption.
    for (let frame = 0; frame <= SHIP.RESPAWN_DELAY_FRAMES && pilot.health <= 0; frame++) {
      engine.advanceOneFrame();
    }
    expect(pilot.health).toBe(pilot.maxHealth);
    expect(pilot.exploding).toBe(false);
    expect(pilot.respawnTimer).toBeUndefined();
    expect(pilot.explodeTime).toBeUndefined();
    const spawnPosition = { ...pilot.position };
    expect(spawnPosition).not.toEqual({ x: 3150, y: 0 });
    peer.clear();

    core.handleClientMessage(
      {
        type: 'update',
        id: pilot.id,
        data: {
          position: spawnPosition,
          velocity: { x: 0, y: 0 },
          angle: 0,
          thrusting: false,
          motionEpoch: pilot.asteroidMotion?.epoch,
          motionSequence: 1,
          exploding: true,
          health: 0,
          score: 0,
          ...extras,
        },
      },
      owner
    );

    expect(pilot.health).toBe(pilot.maxHealth);
    expect(pilot.exploding).toBe(false);
    expect(pilot.explodeTime).toBeUndefined();
    expect(pilot.deathCause).toBeUndefined();
    expect(pilot).not.toHaveProperty('respawnAnchor');
    expect(pilot.asteroidMotion).toMatchObject({ mode: 'free', ack: 1 });
    expect(pilot.score).toBe(17);
    expect(peer.inbox.some((message) => message.type === 'playerUpdate')).toBe(false);

    for (let frame = 0; frame <= SHIP.EXPLODE_DURATION_FRAMES; frame++) {
      engine.advanceOneFrame();
    }
    const nextPosition = { x: spawnPosition.x + 25, y: spawnPosition.y };
    core.handleClientMessage(
      {
        type: 'update',
        id: pilot.id,
        data: {
          position: nextPosition,
          velocity: { x: 0, y: 0 },
          angle: 0,
          thrusting: false,
          motionEpoch: pilot.asteroidMotion?.epoch,
          motionSequence: 2,
          exploding: false,
        },
      },
      owner
    );
    expect(pilot.position).toEqual(nextPosition);
    expect(pilot.health).toBe(pilot.maxHealth);
    expect(pilot.exploding).toBe(false);
    expect(pilot.respawnTimer).toBeUndefined();
    expect(pilot.lives).toBe(2);
    const publicState = engine.getGameState().entities.find((entity) => entity.id === pilot.id);
    expect(publicState).toMatchObject({
      health: pilot.maxHealth,
      exploding: false,
      lives: 2,
      score: 17,
    });
  });
});
