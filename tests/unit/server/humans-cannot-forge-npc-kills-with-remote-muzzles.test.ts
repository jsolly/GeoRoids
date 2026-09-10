import { strict as assert } from 'node:assert';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { MessageHandler } from '../../../server/communication/MessageHandler';
import {
  GameEngine,
  HUMAN_LASER_MAX_LIFETIME_MS,
  HUMAN_SHOOT_POSE_ALLOWANCE_MS,
} from '../../../server/core/GameEngine';
import { GameStateBroadcaster } from '../../../server/services/GameStateBroadcaster';
import { DAMAGE, GAME, LASER, SHIP } from '../../../src/constants';
import { getShipKit } from '../../../src/entities/ship/shipKits';
import { calculateLaserStartPosition } from '../../../src/entities/ship/shipUtils';
import { RecordingSocket } from '../../support/recordingSocket';

vi.mock('../../../setup/serverLogger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

describe('human shoot evidence is grounded before an EO damage report', () => {
  let engine: GameEngine;
  let handler: MessageHandler;
  let socket: RecordingSocket;
  beforeEach(() => {
    engine = new GameEngine(921);
    handler = new MessageHandler(engine, new GameStateBroadcaster(engine));
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

  function shoot(position = { x: 20, y: 0 }, velocity = { x: LASER.SPEED / GAME.FPS, y: 0 }) {
    handler.handleMessage(
      { type: 'shoot', id: 'pilot', data: { laserStart: position, laserDirection: velocity } },
      socket
    );
  }

  test('a joined distant or dead attacker cannot manufacture satellite hit evidence', () => {
    const satellite = engine.getAllSatellites()[0];
    assert.ok(satellite, 'distant satellite');
    const distantSatellite = engine.getSatellite(satellite.id);
    assert.ok(distantSatellite, 'distant satellite state');
    distantSatellite.position = {
      x: 1500,
      y: 0,
    };
    const remoteOrigin = { x: 1500, y: 0 };
    for (let i = 0; i < 2; i++) {
      shoot(remoteOrigin);
      handler.handleMessage(
        {
          type: 'satelliteDamage',
          data: { satelliteId: satellite.id, attackerId: 'pilot', laserPosition: remoteOrigin },
        },
        socket
      );
    }
    expect(engine.getServerLasers()).toHaveLength(0);
    expect(engine.getSatellite(satellite.id)?.health).toBe(satellite.health);
    expect(engine.getPlayer('pilot')?.score).toBe(0);
    expect(engine.getLoot()).toEqual([]);
    const pilot = engine.getPlayer('pilot');
    assert.ok(pilot, 'pilot state');
    pilot.health = 0;
    shoot();
    expect(engine.getServerLasers()).toHaveLength(0);
  });

  test('a nearby real shot damages the EO hull once and cannot be replayed', () => {
    const satellite = engine.getAllSatellites()[0];
    assert.ok(satellite, 'nearby satellite');
    const nearbySatellite = engine.getSatellite(satellite.id);
    assert.ok(nearbySatellite, 'nearby satellite state');
    nearbySatellite.position = {
      x: 40,
      y: 0,
    };
    shoot();
    const report = {
      type: 'satelliteDamage',
      data: { satelliteId: satellite.id, attackerId: 'pilot', laserPosition: { x: 40, y: 0 } },
    };
    handler.handleMessage(report, socket);
    handler.handleMessage(report, socket);
    expect(engine.getSatellite(satellite.id)?.health).toBe(satellite.health - DAMAGE.LASER_HIT);
    expect(engine.getPlayer('pilot')?.score).toBe(0);
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

  test('normal cadence and bunched skirmisher E rounds work but unbounded bursts do not', () => {
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

  test('counter-thrust stationary shots have a finite server lifetime', () => {
    const clock = vi.spyOn(engine, 'getServerTime').mockReturnValue(1000);
    shoot({ x: 20, y: 0 }, { x: 0, y: 0 });
    expect(engine.getServerLasers()).toHaveLength(1);
    clock.mockReturnValue(1000 + HUMAN_LASER_MAX_LIFETIME_MS);
    engine.advanceLasersAndResolveHits();
    expect(engine.getServerLasers()).toHaveLength(0);
  });
});
