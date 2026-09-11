import { strict as assert } from 'node:assert';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { MessageHandler } from '../../../server/communication/MessageHandler';
import {
  GameEngine,
  HUMAN_LASER_MAX_LIFETIME_MS,
  HUMAN_SHOOT_POSE_ALLOWANCE_MS,
} from '../../../server/core/GameEngine';
import { GameStateBroadcaster } from '../../../server/services/GameStateBroadcaster';
import { radiusFromMass } from '../../../shared/shipGrowth';
import { GAME, LASER, SHIP } from '../../../src/constants';
import { getShipKit } from '../../../src/entities/ship/shipKits';
import { calculateLaserStartPosition } from '../../../src/entities/ship/shipUtils';
import {
  createSkirmisherRingShots,
  SKIRMISHER_RING_COUNT,
} from '../../../src/entities/ship/skirmisherRing';
import { RecordingSocket } from '../../support/recordingSocket';

vi.mock('../../../setup/serverLogger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

describe('server-authoritative human shooting', () => {
  let engine: GameEngine;
  let handler: MessageHandler;
  let broadcaster: GameStateBroadcaster;
  let socket: RecordingSocket;
  beforeEach(() => {
    engine = new GameEngine(921);
    broadcaster = new GameStateBroadcaster(engine);
    handler = new MessageHandler(engine, broadcaster);
    socket = new RecordingSocket();
    engine.addPlayer('pilot', 'Pilot', socket, { x: 0, y: 0 }, undefined, 'dart');
    for (const asteroid of engine.getAllAsteroids()) {
      engine.removeAsteroid(asteroid.id);
    }
  });
  afterEach(() => {
    engine.stopGameLoop();
    vi.restoreAllMocks();
  });

  function shoot(
    position = { x: 20, y: 0 },
    velocity = { x: LASER.SPEED / GAME.FPS, y: 0 },
    requestId?: string
  ) {
    handler.handleMessage(
      {
        type: 'shoot',
        id: 'pilot',
        data: {
          laserStart: position,
          laserDirection: velocity,
          ...(requestId !== undefined ? { requestId } : {}),
        },
      },
      socket
    );
  }

  test('acknowledgement precedes immediate hit resolution and its broadcast', () => {
    const order: string[] = [];
    vi.spyOn(broadcaster, 'sendToWebSocket').mockImplementation(() => {
      order.push('acknowledgement');
    });
    const originalResolve = engine.resolveSpawnedLaserHits.bind(engine);
    vi.spyOn(engine, 'resolveSpawnedLaserHits').mockImplementation((...args) => {
      order.push('resolve');
      return originalResolve(...args);
    });
    const originalBroadcast = handler.broadcastAppliedAsteroidHits.bind(handler);
    vi.spyOn(handler, 'broadcastAppliedAsteroidHits').mockImplementation((hits) => {
      order.push('broadcast');
      originalBroadcast(hits);
    });

    shoot({ x: 20, y: 0 }, { x: LASER.SPEED / GAME.FPS, y: 0 }, 'ordered-shot');

    expect(order).toEqual(['acknowledgement', 'resolve', 'broadcast']);
  });

  test('acknowledgement stays ahead of the next authoritative snapshot on the same socket', () => {
    broadcaster.negotiateSnapshot(socket);
    shoot({ x: 20, y: 0 }, { x: LASER.SPEED / GAME.FPS, y: 0 }, 'snapshot-order');
    broadcaster.broadcastGameState();

    const acknowledgementIndex = socket.inbox.findIndex(
      (message) => message.type === 'shotAcknowledged'
    );
    const snapshotIndex = socket.inbox.findIndex((message) => message.type === 'snapshot');
    expect(acknowledgementIndex).toBeGreaterThanOrEqual(0);
    expect(snapshotIndex).toBeGreaterThan(acknowledgementIndex);
  });

  test('accepted shots acknowledge their distinct authoritative projectile IDs', () => {
    shoot({ x: 20, y: 0 }, { x: LASER.SPEED / GAME.FPS, y: 0 }, 'shot-1');
    shoot({ x: 20, y: 0 }, { x: LASER.SPEED / GAME.FPS, y: 0 }, 'shot-2');
    shoot({ x: 20, y: 0 }, { x: LASER.SPEED / GAME.FPS, y: 0 }, 'shot-3');

    const acknowledgements = socket.received('shotAcknowledged');
    expect(acknowledgements).toHaveLength(3);
    expect(acknowledgements.map((message) => message.data)).toEqual([
      { requestId: 'shot-1', projectileId: engine.getServerLasers()[0]?.id },
      { requestId: 'shot-2', projectileId: engine.getServerLasers()[1]?.id },
      { requestId: 'shot-3', projectileId: engine.getServerLasers()[2]?.id },
    ]);
    expect(new Set(engine.getServerLasers().map((laser) => laser.id)).size).toBe(3);
  });

  test('accepted and rejected owned shots acknowledge the authoritative outcome', () => {
    shoot({ x: 20, y: 0 }, { x: LASER.SPEED / GAME.FPS, y: 0 }, 'accepted');
    shoot({ x: 1000, y: 0 }, { x: LASER.SPEED / GAME.FPS, y: 0 }, 'rejected');

    expect(socket.received('shotAcknowledged').map((message) => message.data)).toEqual([
      { requestId: 'accepted', projectileId: engine.getServerLasers()[0]?.id },
      { requestId: 'rejected', projectileId: null },
    ]);
    expect(engine.getServerLasers()).toHaveLength(1);
  });

  test('finite speed bounds and live ownership reject malformed, unjoined and respawning shots', () => {
    expect(engine.spawnHumanLaser('missing', { x: 20, y: 0 }, { x: 5, y: 0 })).toBeNull();
    shoot({ x: Number.POSITIVE_INFINITY, y: 0 });
    shoot({ x: 20, y: 0 }, { x: 1e10, y: 0 });
    shoot({ x: 20, y: 0 }, { x: Number.NaN, y: 0 });
    const pilot = engine.getPlayer('pilot');
    assert.ok(pilot, 'respawning pilot');
    pilot.respawnTimer = 2;
    shoot();
    expect(engine.getServerLasers()).toHaveLength(0);
  });

  test('an unpulsed pilot cannot borrow Quake speed or distant muzzle allowance', () => {
    shoot({ x: 20, y: 0 }, { x: 37, y: 0 });
    shoot({ x: 400, y: 0 });
    expect(engine.getServerLasers()).toHaveLength(0);
  });

  test('a legitimate muzzle from a 250 ms delayed pose is accepted with inherited ship speed', () => {
    const player = engine.getPlayer('pilot');
    assert.ok(player, 'delayed pose pilot');
    const kit = getShipKit(player.kitId);
    player.velocity = { x: kit.maxVelocity, y: 0 };
    const delayedPosition = {
      x: (-kit.maxVelocity * GAME.FPS * HUMAN_SHOOT_POSE_ALLOWANCE_MS) / 1000,
      y: 0,
    };
    const muzzle = calculateLaserStartPosition(delayedPosition, 0, kit.size / 2);
    shoot(muzzle, { x: kit.maxVelocity + LASER.SPEED / GAME.FPS, y: 0 });
    expect(engine.getServerLasers()).toHaveLength(1);
  });

  test('normal Skirmisher firing stays bounded by the regular shot cadence', () => {
    const clock = vi.spyOn(engine, 'getServerTime').mockReturnValue(1000);
    const player = engine.getPlayer('pilot');
    assert.ok(player, 'skirmisher pilot');
    player.kitId = 'skirmisher';
    for (let i = 0; i < SHIP.MAX_LASERS; i++) {
      shoot();
    }
    shoot();
    expect(engine.getServerLasers()).toHaveLength(SHIP.MAX_LASERS);
    clock.mockReturnValue(1000 + getShipKit('skirmisher').shotCooldown);
    shoot();
    expect(engine.getServerLasers()).toHaveLength(SHIP.MAX_LASERS + 1);
  });

  test('Skirmisher E creates one authoritative projectile for every ring heading', () => {
    const pilot = engine.getPlayer('pilot');
    assert.ok(pilot, 'skirmisher pilot');
    pilot.kitId = 'skirmisher';
    pilot.position = { x: 140, y: -90 };
    pilot.angle = Math.PI / 5;
    pilot.velocity = { x: 1.5, y: -0.75 };

    expect(engine.useAbility('pilot', 'skirmisher')).toBe(true);
    const actual = engine.getServerLasers();
    const expected = createSkirmisherRingShots(
      pilot.position,
      pilot.angle,
      radiusFromMass(pilot.mass),
      pilot.velocity
    );

    expect(actual).toHaveLength(SKIRMISHER_RING_COUNT);
    expect(new Set(actual.map((laser) => laser.velocity.x.toFixed(6))).size).toBeGreaterThan(1);
    for (const [index, laser] of actual.entries()) {
      const shot = expected[index];
      expect(shot).toBeDefined();
      if (shot) {
        expect(laser.position.x).toBeCloseTo(shot.position.x, 8);
        expect(laser.position.y).toBeCloseTo(shot.position.y, 8);
        expect(laser.velocity.x).toBeCloseTo(shot.velocity.x, 8);
        expect(laser.velocity.y).toBeCloseTo(shot.velocity.y, 8);
      }
    }
  });

  test('counter-thrust stationary shots have a finite server lifetime', () => {
    const clock = vi.spyOn(engine, 'getServerTime').mockReturnValue(1000);
    shoot({ x: 20, y: 0 }, { x: 0, y: 0 });
    expect(engine.getServerLasers()).toHaveLength(1);
    expect(socket.received('shotAcknowledged')).toHaveLength(0);
    clock.mockReturnValue(1000 + HUMAN_LASER_MAX_LIFETIME_MS);
    engine.advanceLasersAndResolveHits();
    expect(engine.getServerLasers()).toHaveLength(0);
  });
});
