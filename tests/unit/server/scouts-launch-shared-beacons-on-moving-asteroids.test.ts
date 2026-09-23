/* @vitest-environment node */
import { strict as assert } from 'node:assert';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { WebSocketCore } from '../../../server/communication/WebSocketCore';
import { AsteroidManager } from '../../../server/core/AsteroidManager';
import { GameEngine } from '../../../server/core/GameEngine';
import { RNGService } from '../../../server/core/RNGService';
import { ServerClock } from '../../../server/core/ServerClock';
import { SurveyProbeManager } from '../../../server/core/SurveyProbeManager';
import { RegionalAsteroidField } from '../../../server/world/RegionalAsteroidField';
import { probePosition, SURVEY_PROBE } from '../../../shared/surveyProbe';
import type { AsteroidData } from '../../../shared-types';
import { RecordingSocket } from '../../support/recordingSocket';

function asteroidAt(id: string, position: { x: number; y: number }): AsteroidData {
  return {
    id,
    position,
    velocity: { x: 0, y: 0 },
    size: 25,
    jaggedness: 0.4,
    rotation: 0,
    angularVelocity: 0,
    health: 40,
    maxHealth: 40,
    vertices: 8,
    offsets: [1, 1, 1, 1, 1, 1, 1, 1],
  };
}

function clearAsteroids(engine: GameEngine): void {
  for (const asteroid of engine.getAllAsteroids()) {
    engine.removeAsteroid(asteroid.id);
  }
}

function launchWorld(): {
  engine: GameEngine;
  scout: ReturnType<GameEngine['getPlayer']>;
  now: { value: number };
} {
  const now = { value: Date.now() };
  const clock = new ServerClock({
    wallNow: () => now.value,
    monotonicNow: () => now.value,
  });
  const engine = new GameEngine(42, clock);
  const pilot = engine.addPlayer('scout', 'Scout', new RecordingSocket(), { x: 0, y: 0 });
  pilot.position = { x: 0, y: 0 };
  pilot.angle = 0;
  clearAsteroids(engine);
  pilot.equipment = ['survey_probe'];
  engine.setScoutUtility(pilot.id, 'survey_probe');
  vi.spyOn(engine, 'getServerTime').mockImplementation(() => now.value);
  return { engine, scout: engine.getPlayer(pilot.id), now };
}

function probePilot(position: { x: number; y: number }) {
  return {
    id: 'pilot',
    position,
    angle: 0,
    kitId: 'scout' as const,
    exploding: false,
    health: 100,
    abilityCooldownFrames: 0,
  };
}

describe('authoritative Scout probes', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('a forward launch attaches to the first polygon face and credits its host', () => {
    const { engine, scout, now } = launchWorld();
    assert.ok(scout);
    const host = asteroidAt('first-host', { x: 200, y: 0 });
    const fartherHost = asteroidAt('farther-host', { x: 400, y: 0 });
    engine.addAsteroid(host);
    engine.addAsteroid(fartherHost);

    expect(engine.useAbility(scout.id, 'scout')).toBe(true);
    assert.ok(host.probe);
    expect(host.probe.ownerId).toBe(scout.id);
    expect(host.probe.health).toBe(SURVEY_PROBE.MAX_HEALTH);
    expect(host.probe.attachedAt).toBe(now.value);
    expect(host.probe.expiresAt).toBe(now.value + SURVEY_PROBE.LIFETIME_MS);
    expect(host.surveyedBy).toEqual([scout.id]);
    expect(fartherHost.probe).toBeUndefined();
    expect(probePosition(host, host.probe).x).toBeLessThan(host.position.x);
    expect(
      engine.getGameState().asteroids.find((asteroid) => asteroid.id === host.id)?.probe
    ).toEqual(host.probe);
  });

  test('a beacon follows host motion and pulses a nearby deposit at its world position', () => {
    const { engine, scout, now } = launchWorld();
    assert.ok(scout);
    const host = asteroidAt('moving-host', { x: 200, y: 0 });
    engine.addAsteroid(host);
    expect(engine.useAbility(scout.id, 'scout')).toBe(true);
    assert.ok(host.probe);
    const before = probePosition(host, host.probe);

    host.position = { x: 320, y: 80 };
    host.rotation = Math.PI / 2;
    const after = probePosition(host, host.probe);
    const nearby = asteroidAt('beacon-target', { x: after.x + 30, y: after.y });
    const outside = asteroidAt('outside-beacon-range', {
      x: after.x + SURVEY_PROBE.RANGE + 30,
      y: after.y,
    });
    engine.addAsteroid(nearby);
    engine.addAsteroid(outside);
    now.value += SURVEY_PROBE.PULSE_MS - 1;
    engine.advanceOneFrame(now.value);

    expect(after).not.toEqual(before);
    expect(nearby.surveyedBy).toBeUndefined();
    expect(outside.surveyedBy).toBeUndefined();
    now.value += 1;
    engine.advanceOneFrame(now.value);
    expect(nearby.surveyedBy).toContain(scout.id);
    expect(outside.surveyedBy).toBeUndefined();
  });

  test('launch selects the nearest polygon and rejects range and occupied hosts', () => {
    const manager = new SurveyProbeManager();
    const pilot = probePilot({ x: 0, y: 0 });
    const near = asteroidAt('near-host', { x: 300, y: 0 });
    const far = asteroidAt('far-host', { x: 500, y: 0 });

    expect(manager.launch(pilot, [near, far], 1_000)).toMatchObject({ host: near });
    expect(far.probe).toBeUndefined();

    pilot.abilityCooldownFrames = 0;
    expect(manager.launch(pilot, [near], 1_001)).toBeNull();

    pilot.position = { x: 0, y: 1_000 };
    pilot.abilityCooldownFrames = 0;
    const outside = asteroidAt('outside-launch-range', { x: 800, y: 1_000 });
    expect(manager.launch(pilot, [outside], 1_002)).toBeNull();

    pilot.position = { x: 1_800, y: 1_000 };
    pilot.abilityCooldownFrames = 0;
    const distantHost = asteroidAt('distant-host', { x: 2_100, y: 1_000 });
    expect(manager.launch(pilot, [distantHost], 1_003)).toMatchObject({ host: distantHost });
  });

  test('idle pulse ticks do not materialize the asteroid source before a due pulse', () => {
    const manager = new SurveyProbeManager();
    const pilot = probePilot({ x: 0, y: 0 });
    const host = asteroidAt('lazy-host', { x: 300, y: 0 });
    expect(manager.launch(pilot, [host], 1_000)).not.toBeNull();
    let materializations = 0;
    const source = () => {
      materializations++;
      return [host];
    };
    const lookup = (asteroidId: string) => (asteroidId === host.id ? host : undefined);

    manager.tick(1_000 + SURVEY_PROBE.PULSE_MS - 1, source, lookup, () => undefined);
    expect(materializations).toBe(0);
    manager.tick(1_000 + SURVEY_PROBE.PULSE_MS, source, lookup, () => undefined);
    expect(materializations).toBe(1);
  });

  test('a large host is identified immediately even when its center is outside pulse range', () => {
    const { engine, scout } = launchWorld();
    assert.ok(scout);
    const largeHost = asteroidAt('large-host', { x: 1_200, y: 0 });
    largeHost.size = 1_000;
    engine.addAsteroid(largeHost);

    expect(engine.useAbility(scout.id, 'scout')).toBe(true);
    assert.ok(largeHost.probe);
    const beacon = probePosition(largeHost, largeHost.probe);
    expect(
      Math.hypot(beacon.x - largeHost.position.x, beacon.y - largeHost.position.y)
    ).toBeGreaterThan(SURVEY_PROBE.RANGE);
    expect(largeHost.surveyedBy).toContain(scout.id);
  });

  test('the fourth successful launch replaces the oldest beacon while a miss preserves it', () => {
    const { engine, scout, now } = launchWorld();
    assert.ok(scout);
    const hosts = [0, 1, 2, 3].map((index) =>
      asteroidAt(`host-${index}`, { x: 200, y: index * 120 })
    );
    for (const [index, host] of hosts.entries()) {
      engine.addAsteroid(host);
      scout.position = { x: 0, y: host.position.y };
      scout.abilityCooldownFrames = 0;
      now.value += 1_000;
      expect(engine.useAbility(scout.id, 'scout')).toBe(true);
      if (index < 3) {
        expect(host.probe).toBeDefined();
      }
    }
    expect(hosts[0]?.probe).toBeNull();
    expect(hosts.slice(1).every((host) => host.probe?.ownerId === scout.id)).toBe(true);

    scout.position = { x: 0, y: -400 };
    scout.abilityCooldownFrames = 0;
    now.value += 1_000;
    expect(engine.useAbility(scout.id, 'scout')).toBe(false);
    expect(hosts[1]?.probe).toBeDefined();
    expect(hosts[2]?.probe).toBeDefined();
    expect(hosts[3]?.probe).toBeDefined();
  });

  test('an unbounced authoritative laser damages a beacon before its asteroid', () => {
    const { engine, scout, now } = launchWorld();
    assert.ok(scout);
    const host = asteroidAt('projectile-host', { x: 200, y: 0 });
    engine.addAsteroid(host);
    expect(engine.useAbility(scout.id, 'scout')).toBe(true);
    assert.ok(host.probe);

    engine.spawnLaser('shooter', { x: 120, y: 0 }, { x: 60, y: 0 }, now.value);
    engine.advanceLasersAndResolveHits(now.value + 1);
    expect(host.probe?.health).toBe(SURVEY_PROBE.MAX_HEALTH - 25);
    expect(host.health).toBe(host.maxHealth);

    engine.spawnLaser('shooter', { x: 120, y: 0 }, { x: 60, y: 0 }, now.value + 2);
    engine.advanceLasersAndResolveHits(now.value + 3);
    expect(host.probe).toBeNull();
    expect(engine.getAsteroid(host.id)).toBe(host);
  });

  test('expiry and host removal clear the embedded beacon metadata', () => {
    const { engine, scout, now } = launchWorld();
    assert.ok(scout);
    const host = asteroidAt('expiring-host', { x: 200, y: 0 });
    engine.addAsteroid(host);
    expect(engine.useAbility(scout.id, 'scout')).toBe(true);
    now.value += SURVEY_PROBE.LIFETIME_MS;
    scout.lastUpdate = now.value;
    engine.advanceOneFrame(now.value);
    expect(host.probe).toBeNull();

    scout.abilityCooldownFrames = 0;
    now.value += 1;
    expect(engine.useAbility(scout.id, 'scout')).toBe(true);
    engine.removeAsteroid(host.id);
    expect(engine.getAsteroid(host.id)).toBeUndefined();
  });

  test('a beacon survives owner departure and keeps its distant sector active for a follower', () => {
    const { engine, scout, now } = launchWorld();
    assert.ok(scout);
    const host = asteroidAt('distant-host', { x: 200, y: 0 });
    engine.addAsteroid(host);
    expect(engine.useAbility(scout.id, 'scout')).toBe(true);
    assert.ok(host.probe);

    host.position = { x: 5_000, y: 0 };
    engine.removePlayer(scout.id);
    expect(host.probe).toBeDefined();

    engine.addPlayer('hauler', 'Hauler', new RecordingSocket(), { x: 0, y: 100 });
    engine.ensureAsteroidField();
    expect(engine.getAsteroid(host.id)).toBe(host);

    const target = asteroidAt('distant-target', { x: 5_030, y: 0 });
    engine.addAsteroid(target);
    now.value += SURVEY_PROBE.PULSE_MS;
    engine.advanceOneFrame(now.value);
    expect(target.surveyedBy).toContain(scout.id);
  });

  test('regional checkpoints and restored fields strip transient beacon metadata', () => {
    const host = asteroidAt('persisted-host', { x: 200, y: 200 });
    host.probe = {
      id: 'transient-probe',
      ownerId: 'pilot',
      health: SURVEY_PROBE.MAX_HEALTH,
      maxHealth: SURVEY_PROBE.MAX_HEALTH,
      attachedAt: 1_000,
      expiresAt: 1_000 + SURVEY_PROBE.LIFETIME_MS,
      angle: 0,
      radialOffset: 35,
    };
    const field = new RegionalAsteroidField(42, new Map([['0,0', [host]]]));
    const manager = new AsteroidManager(new RNGService(42));
    field.update(manager, [{ x: 0, y: 0 }]);
    const checkpoint = field.checkpoint(manager);
    const savedHost = checkpoint.get('0,0')?.find((rock) => rock.id === host.id);
    expect(savedHost).toBeDefined();
    expect(savedHost).not.toHaveProperty('probe');

    const restored = new RegionalAsteroidField(42, new Map([['0,0', checkpoint.get('0,0') ?? []]]));
    const restoredManager = new AsteroidManager(new RNGService(42));
    restored.update(restoredManager, [{ x: 0, y: 0 }]);
    expect(restoredManager.getAsteroid(host.id)?.probe).toBeUndefined();
  });

  test('split fragments never inherit the destroyed host beacon', () => {
    const { engine, scout, now } = launchWorld();
    assert.ok(scout);
    const secondShooter = engine.addPlayer('second-shooter', 'Second', new RecordingSocket(), {
      x: 0,
      y: 100,
    });
    const host = asteroidAt('split-host', { x: 200, y: 0 });
    host.size = 100;
    host.probe = {
      id: 'split-probe',
      ownerId: scout.id,
      health: SURVEY_PROBE.MAX_HEALTH,
      maxHealth: SURVEY_PROBE.MAX_HEALTH,
      attachedAt: now.value,
      expiresAt: now.value + SURVEY_PROBE.LIFETIME_MS,
      angle: 0,
      radialOffset: 125,
    };
    engine.addAsteroid(host);

    expect(engine.applyLaserAsteroidHit(host.id, scout.id, 'laser', now.value).outcome).toBe(
      'tagged'
    );
    const destroyed = engine.applyLaserAsteroidHit(
      host.id,
      secondShooter.id,
      'laser',
      now.value + 1
    );
    expect(destroyed.outcome).toBe('destroyed');
    expect(destroyed.newAsteroids.length).toBeGreaterThan(0);
    expect(destroyed.newAsteroids.every((fragment) => fragment.probe === undefined)).toBe(true);
  });

  test('a socket cannot equip or activate a Scout utility for another pilot', () => {
    const engine = new GameEngine(42);
    const core = new WebSocketCore(engine);
    const ownerSocket = new RecordingSocket();
    const attackerSocket = new RecordingSocket();
    const join = (socket: RecordingSocket, id: string) =>
      core.handleClientMessage(
        {
          type: 'join',
          id,
          name: id,
          data: {
            position: { x: 0, y: id === 'owner' ? 0 : 100 },
            snapshotVersion: 1,
            asteroidInteractions: 1,
          },
        },
        socket
      );
    join(ownerSocket, 'owner');
    join(attackerSocket, 'attacker');
    clearAsteroids(engine);
    const owner = engine.getPlayer('owner');
    assert.ok(owner);
    const host = asteroidAt('spoof-host', { x: 200, y: owner.position.y });
    engine.addAsteroid(host);
    owner.angle = 0;
    owner.equipment = ['survey_probe'];

    core.handleClientMessage(
      { type: 'setScoutUtility', id: owner.id, data: { utilityId: 'survey_probe' } },
      attackerSocket
    );
    core.handleClientMessage(
      { type: 'useAbility', id: owner.id, data: { kitId: 'scout' } },
      attackerSocket
    );

    expect(owner.scoutUtility).toBeUndefined();
    expect(host.probe).toBeUndefined();
  });
});
