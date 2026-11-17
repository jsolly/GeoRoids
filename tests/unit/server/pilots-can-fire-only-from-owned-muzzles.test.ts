import { strict as assert } from 'node:assert';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { MessageHandler } from '../../../server/communication/MessageHandler';
import { GameEngine } from '../../../server/core/GameEngine';
import {
  PLAYER_LASER_MAX_LIFETIME_MS,
  PLAYER_SHOOT_POSE_ALLOWANCE_MS,
} from '../../../server/core/LaserCombat';
import { GameStateBroadcaster } from '../../../server/services/GameStateBroadcaster';
import { GAME, LASER, SHIP } from '../../../shared/constants/gameplay';
import { getShipKit } from '../../../shared/shipKits';
import { calculateLaserStartPosition } from '../../../src/entities/ship/shipUtils';
import { RecordingSocket } from '../../support/recordingSocket';

vi.mock('../../../setup/serverLogger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

describe('server-authoritative player shooting', () => {
  let engine: GameEngine;
  let handler: MessageHandler;
  let broadcaster: GameStateBroadcaster;
  let socket: RecordingSocket;
  beforeEach(() => {
    engine = new GameEngine(921);
    broadcaster = new GameStateBroadcaster(engine);
    handler = new MessageHandler(engine, broadcaster);
    socket = new RecordingSocket();
    engine.addPlayer('pilot', 'Pilot', socket, { x: 0, y: 0 }, 'scout');
    for (const asteroid of engine.getAllAsteroids()) {
      engine.asteroidLifecycle.remove(asteroid.id);
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
    const originalResolve = engine.laserCombat.resolveSpawned.bind(engine.laserCombat);
    vi.spyOn(engine.laserCombat, 'resolveSpawned').mockImplementation((...args) => {
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
      { requestId: 'shot-1', projectileId: engine.laserCombat.shots()[0]?.id },
      { requestId: 'shot-2', projectileId: engine.laserCombat.shots()[1]?.id },
      { requestId: 'shot-3', projectileId: engine.laserCombat.shots()[2]?.id },
    ]);
    expect(new Set(engine.laserCombat.shots().map((laser) => laser.id)).size).toBe(3);
  });

  test('accepted and rejected owned shots acknowledge the authoritative outcome', () => {
    shoot({ x: 20, y: 0 }, { x: LASER.SPEED / GAME.FPS, y: 0 }, 'accepted');
    shoot({ x: 1000, y: 0 }, { x: LASER.SPEED / GAME.FPS, y: 0 }, 'rejected');

    expect(socket.received('shotAcknowledged').map((message) => message.data)).toEqual([
      { requestId: 'accepted', projectileId: engine.laserCombat.shots()[0]?.id },
      { requestId: 'rejected', projectileId: null },
    ]);
    expect(engine.laserCombat.shots()).toHaveLength(1);
  });

  test('finite speed bounds and live ownership reject malformed, unjoined and respawning shots', () => {
    expect(engine.laserCombat.spawnPlayer('missing', { x: 20, y: 0 }, { x: 5, y: 0 })).toBeNull();
    shoot({ x: Number.POSITIVE_INFINITY, y: 0 });
    shoot({ x: 20, y: 0 }, { x: 1e10, y: 0 });
    shoot({ x: 20, y: 0 }, { x: Number.NaN, y: 0 });
    const pilot = engine.getPlayer('pilot');
    assert.ok(pilot, 'respawning pilot');
    pilot.respawnTimer = 2;
    shoot();
    expect(engine.laserCombat.shots()).toHaveLength(0);
  });

  test('a pilot cannot claim ungranted speed or distant muzzle allowance', () => {
    shoot({ x: 20, y: 0 }, { x: 37, y: 0 });
    shoot({ x: 400, y: 0 });
    expect(engine.laserCombat.shots()).toHaveLength(0);
  });

  test('a legitimate muzzle from a 250 ms delayed pose is accepted with inherited ship speed', () => {
    const player = engine.getPlayer('pilot');
    assert.ok(player, 'delayed pose pilot');
    const kit = getShipKit(player.kitId);
    player.velocity = { x: SHIP.MAX_VELOCITY, y: 0 };
    const delayedPosition = {
      x: (-SHIP.MAX_VELOCITY * GAME.FPS * PLAYER_SHOOT_POSE_ALLOWANCE_MS) / 1000,
      y: 0,
    };
    const muzzle = calculateLaserStartPosition(delayedPosition, 0, kit.size / 2);
    shoot(muzzle, { x: SHIP.MAX_VELOCITY + LASER.SPEED / GAME.FPS, y: 0 });
    expect(engine.laserCombat.shots()).toHaveLength(1);
  });

  test('normal Scout firing stays bounded by the regular shot cadence', () => {
    const clock = vi.spyOn(engine, 'getServerTime').mockReturnValue(1000);
    const player = engine.getPlayer('pilot');
    assert.ok(player, 'scout pilot');
    player.kitId = 'scout';
    for (let i = 0; i < SHIP.MAX_LASERS; i++) {
      shoot();
    }
    shoot();
    expect(engine.laserCombat.shots()).toHaveLength(SHIP.MAX_LASERS);
    clock.mockReturnValue(1000 + getShipKit('scout').shotCooldown);
    shoot();
    expect(engine.laserCombat.shots()).toHaveLength(SHIP.MAX_LASERS + 1);
  });

  test('a shot flies 800 world units before the server drops it, matching the client reach', () => {
    vi.spyOn(engine, 'getServerTime').mockReturnValue(1000);
    expect(LASER.MAX_TRAVEL_DISTANCE).toBe(800);
    const shot = engine.laserCombat.spawn('pilot', { x: 20, y: 0 }, { x: 4, y: 0 });
    assert.ok(shot, 'spawned shot');
    // 199 steps of 4 = 796 units, still in flight; step 200 lands on 800, which the
    // former 800.6 reach would still have allowed.
    for (let frame = 0; frame < 199; frame += 1) {
      engine.laserCombat.advance();
    }
    expect(engine.laserCombat.shots()).toEqual([shot]);
    expect(shot.distTraveled).toBe(796);
    engine.laserCombat.advance();
    expect(engine.laserCombat.shots()).toHaveLength(0);
  });

  test('counter-thrust stationary shots have a finite server lifetime', () => {
    const clock = vi.spyOn(engine, 'getServerTime').mockReturnValue(1000);
    shoot({ x: 20, y: 0 }, { x: 0, y: 0 });
    expect(engine.laserCombat.shots()).toHaveLength(1);
    expect(socket.received('shotAcknowledged')).toHaveLength(0);
    clock.mockReturnValue(1000 + PLAYER_LASER_MAX_LIFETIME_MS);
    engine.laserCombat.advance();
    expect(engine.laserCombat.shots()).toHaveLength(0);
  });

  test('clearing the world retains the live pilot budget while a replacement pilot starts fresh', () => {
    const clock = vi.spyOn(engine, 'getServerTime').mockReturnValue(1000);
    const originalPilot = engine.getPlayer('pilot');
    assert.ok(originalPilot);
    for (let shot = 0; shot < SHIP.MAX_LASERS; shot++) {
      assert.ok(engine.laserCombat.spawnPlayer('pilot', { x: 20, y: 0 }, { x: 0, y: 0 }));
    }
    expect(engine.laserCombat.spawnPlayer('pilot', { x: 20, y: 0 }, { x: 0, y: 0 })).toBeNull();

    engine.prepareDiagnosticWorld('traversal');
    expect(engine.getPlayer('pilot')).toBe(originalPilot);
    expect(engine.laserCombat.shots()).toEqual([]);
    expect(engine.laserCombat.spawnPlayer('pilot', { x: 20, y: 0 }, { x: 0, y: 0 })).toBeNull();
    clock.mockReturnValue(1000 + getShipKit('scout').shotCooldown);
    assert.ok(engine.laserCombat.spawnPlayer('pilot', { x: 20, y: 0 }, { x: 0, y: 0 }));

    engine.removePlayer('pilot');
    const replacement = engine.addPlayer(
      'pilot',
      'Replacement',
      new RecordingSocket(),
      { x: 0, y: 0 },
      'scout'
    );
    expect(replacement).not.toBe(originalPilot);
    for (let shot = 0; shot < SHIP.MAX_LASERS; shot++) {
      assert.ok(engine.laserCombat.spawnPlayer('pilot', { x: 20, y: 0 }, { x: 0, y: 0 }));
    }
    expect(engine.laserCombat.spawnPlayer('pilot', { x: 20, y: 0 }, { x: 0, y: 0 })).toBeNull();
  });

  test('production fixture denial preserves current evidence and a new fixture starts empty', () => {
    engine.laserCombat.observeFixtureShots('test', ['pilot']);
    const accepted = engine.laserCombat.spawnPlayer('pilot', { x: 20, y: 0 }, { x: 0, y: 0 });
    assert.ok(accepted);
    const evidence = engine.laserCombat.getFixtureCombatEvidence();
    expect(evidence.events).toHaveLength(1);
    expect(evidence.events[0]).toMatchObject({
      kind: 'admission',
      ownerId: 'pilot',
      projectileId: accepted.id,
      rejectionReason: null,
    });
    expect(() => engine.laserCombat.observeFixtureShots('production', ['pilot'])).toThrow(
      'Combat fixture evidence is unavailable in production'
    );
    expect(engine.laserCombat.getFixtureCombatEvidence()).toEqual(evidence);

    engine.laserCombat.observeFixtureShots('development', ['pilot']);
    expect(engine.laserCombat.getFixtureCombatEvidence()).toEqual({ events: [], dropped: 0 });
    expect(
      engine.laserCombat.spawnPlayer('pilot', { x: Number.NaN, y: 0 }, { x: 0, y: 0 })
    ).toBeNull();
    expect(engine.laserCombat.getFixtureCombatEvidence().events).toEqual([
      expect.objectContaining({
        kind: 'admission',
        ownerId: 'pilot',
        projectileId: null,
        rejectionReason: 'invalid-pilot-or-request',
        sequence: 0,
      }),
    ]);
    engine.resetForTesting();
    expect(engine.laserCombat.getFixtureCombatEvidence()).toEqual({ events: [], dropped: 0 });
  });
});
