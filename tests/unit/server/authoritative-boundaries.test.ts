/* @vitest-environment node */
import { afterEach, describe, expect, test } from 'vitest';
import { WebSocket } from 'ws';

import { WebSocketCore } from '../../../server/communication/WebSocketCore';
import { GameEngine } from '../../../server/core/GameEngine';
import type { AsteroidData } from '../../../shared-types';
import { DAMAGE } from '../../../src/constants';

function mockWs(): WebSocket {
  return {
    readyState: WebSocket.OPEN,
    send: () => undefined,
  } as unknown as WebSocket;
}

function addDropAsteroid(engine: GameEngine, id: string): void {
  engine.addAsteroid({
    id,
    position: { x: 0, y: 0 },
    velocity: { x: 0, y: 0 },
    size: 20,
    jaggedness: 0.5,
    rotation: 0,
    angularVelocity: 0,
    health: 20,
    maxHealth: 20,
    vertices: 8,
    offsets: [1, 1, 1, 1, 1, 1, 1, 1],
  });
}

function addRubble(engine: GameEngine): AsteroidData {
  const rubble: AsteroidData = {
    id: 'rubble-ram-target',
    material: 'rubble',
    position: { x: 0, y: 0 },
    velocity: { x: 0, y: 0 },
    size: 50,
    jaggedness: 0.7,
    rotation: 0,
    angularVelocity: 0,
    health: 40,
    maxHealth: 40,
    vertices: 8,
    offsets: [1, 1, 1, 1, 1, 1, 1, 1],
  };
  engine.addAsteroid(rubble);
  return rubble;
}

describe('server authority boundaries', () => {
  let engine: GameEngine | undefined;

  afterEach(() => {
    engine?.stopGameLoop();
    engine = undefined;
  });

  test('a second pilot cannot detonate a drop through a bot identity', () => {
    engine = new GameEngine(41);
    const core = new WebSocketCore(engine);
    const ownerWs = mockWs();
    const attackerWs = mockWs();

    core.handleClientMessage(
      { type: 'join', data: { id: 'owner', name: 'Owner', position: { x: 0, y: 0 } } },
      ownerWs
    );
    core.handleClientMessage(
      { type: 'join', data: { id: 'attacker', name: 'Attacker', position: { x: 1000, y: 0 } } },
      attackerWs
    );
    const bot = engine.createBots(1)?.[0];
    expect(bot).toBeDefined();
    bot!.position = { x: 0, y: 0 };
    bot!.spawnProtectionTimer = undefined;

    addDropAsteroid(engine, 'drop-source');
    expect(engine.handleAsteroidHit('drop-source', 'owner', 'laser').outcome).toBe('destroyed');
    const shard = engine.getLoot()[0];
    expect(shard).toBeDefined();
    const botHealth = bot!.health;

    core.handleClientMessage(
      {
        type: 'lootExplode',
        id: 'attacker',
        data: { lootId: shard!.id, playerId: bot!.id },
      },
      attackerWs
    );

    expect(engine.getLoot()).toHaveLength(1);
    expect(bot!.health).toBe(botHealth);

    const botShot = engine.spawnLaser(bot!.id, shard!.position, { x: 0, y: 0 });
    expect(botShot).toBeDefined();
    core.handleClientMessage(
      {
        type: 'lootExplode',
        id: 'attacker',
        data: { lootId: shard!.id, playerId: bot!.id },
      },
      attackerWs
    );
    expect(engine.getLoot()).toHaveLength(0);
    expect(botShot?.hasExploded).toBe(true);

    addDropAsteroid(engine, 'second-drop-source');
    expect(engine.handleAsteroidHit('second-drop-source', 'owner', 'laser').outcome).toBe('destroyed');
    const secondShard = engine.getLoot()[0];
    expect(secondShard).toBeDefined();

    // A second client cannot replay the consumed bot shot against a new drop.
    core.handleClientMessage(
      {
        type: 'lootExplode',
        id: 'owner',
        data: { lootId: secondShard!.id, playerId: bot!.id },
      },
      ownerWs
    );
    expect(engine.getLoot()).toHaveLength(1);

    // The server-owned engine path remains available for bot AI; only the
    // client resolver requires a tracked projectile.
    const internal = engine.handleLootExplode(bot!.id, secondShard!.id);
    expect(internal.success).toBe(true);
    expect(engine.getLoot()).toHaveLength(0);
  });

  test('an ability request cannot switch the kit selected at join', () => {
    engine = new GameEngine(42);
    const core = new WebSocketCore(engine);
    const ws = mockWs();
    core.handleClientMessage(
      {
        type: 'join',
        data: { id: 'pilot', name: 'Pilot', kitId: 'dart', position: { x: 0, y: 0 } },
      },
      ws
    );

    const pilot = engine.getPlayer('pilot');
    expect(pilot).toBeDefined();
    const maxHealth = pilot!.maxHealth;

    core.handleClientMessage(
      {
        type: 'useAbility',
        id: 'pilot',
        data: { kitId: 'hauler', abilityId: 'harpoon' },
      },
      ws
    );

    expect(pilot!.kitId).toBe('dart');
    expect(pilot!.maxHealth).toBe(maxHealth);
    expect(engine.useAbility('pilot', 'hauler')).toBe(false);
    expect(pilot!.abilityCooldownFrames).toBe(0);

    core.handleClientMessage(
      {
        type: 'useAbility',
        id: 'pilot',
        data: { kitId: 'dart', abilityId: 'boostDash' },
      },
      ws
    );
    expect(pilot!.kitId).toBe('dart');
    expect(pilot!.abilityCooldownFrames).toBeGreaterThan(0);
  });

  test('bot damage needs one joined owner shot and applies canonical damage once', () => {
    engine = new GameEngine(44);
    const core = new WebSocketCore(engine);
    const pilotWs = mockWs();
    const otherWs = mockWs();
    const unjoinedWs = mockWs();
    core.handleClientMessage(
      { type: 'join', data: { id: 'pilot', name: 'Pilot', position: { x: 0, y: 0 } } },
      pilotWs
    );
    core.handleClientMessage(
      { type: 'join', data: { id: 'other', name: 'Other', position: { x: 1000, y: 0 } } },
      otherWs
    );
    for (const asteroid of engine.getAllAsteroids()) {
      engine.removeAsteroid(asteroid.id);
    }

    const bot = engine.createBots(1)?.[0];
    expect(bot).toBeDefined();
    engine.updatePlayer('pilot', {
      factionId: 'ion',
      spawnProtectionTimer: undefined,
      position: { x: 0, y: 0 },
    });
    engine.updateBot(bot!.id, {
      factionId: 'ember',
      spawnProtectionTimer: undefined,
      position: { x: 0, y: 0 },
    });
    const healthBefore = bot!.health;
    const report = {
      type: 'botDamage',
      data: { botId: bot!.id, attackerId: 'pilot', damage: 999_999 },
    };

    // A forged/oversized report, including from another or unjoined socket,
    // has no effect without a server-tracked shot.
    core.handleClientMessage(report, pilotWs);
    core.handleClientMessage(report, otherWs);
    core.handleClientMessage(report, unjoinedWs);
    core.handleClientMessage(
      {
        type: 'laserDamage',
        data: { targetPlayerId: bot!.id, attackerId: 'pilot', damage: 999_999 },
      },
      pilotWs
    );
    expect(bot!.health).toBe(healthBefore);

    core.handleClientMessage(
      {
        type: 'shoot',
        id: 'pilot',
        data: { laserStart: { x: 0, y: 0 }, laserDirection: { x: 0, y: 0 } },
      },
      pilotWs
    );
    const shot = engine.getServerLasers()[0];
    expect(shot).toBeDefined();

    core.handleClientMessage(report, pilotWs);
    expect(bot!.health).toBe(healthBefore - DAMAGE.LASER_HIT);
    expect(shot!.hasExploded).toBe(true);

    // The consumed shot cannot be replayed for another damage tick.
    core.handleClientMessage(report, pilotWs);
    expect(bot!.health).toBe(healthBefore - DAMAGE.LASER_HIT);

    // The legacy laserDamage envelope uses the same one-use evidence gate.
    core.handleClientMessage(
      {
        type: 'shoot',
        id: 'pilot',
        data: { laserStart: { x: 0, y: 0 }, laserDirection: { x: 0, y: 0 } },
      },
      pilotWs
    );
    core.handleClientMessage(
      {
        type: 'laserDamage',
        data: { targetPlayerId: bot!.id, attackerId: 'pilot', damage: 999_999 },
      },
      pilotWs
    );
    expect(bot!.health).toBe(healthBefore - DAMAGE.LASER_HIT * 2);
  });

  test('initAsteroids only serves the joined socket owner', () => {
    engine = new GameEngine(45);
    const core = new WebSocketCore(engine);
    const ownerWs = mockWs();
    const otherWs = mockWs();
    const unjoinedWs = mockWs();
    core.handleClientMessage(
      { type: 'join', data: { id: 'owner', name: 'Owner', position: { x: 0, y: 0 } } },
      ownerWs
    );
    core.handleClientMessage(
      { type: 'join', data: { id: 'other', name: 'Other', position: { x: 100, y: 0 } } },
      otherWs
    );
    for (const asteroid of engine.getAllAsteroids()) {
      engine.removeAsteroid(asteroid.id);
    }

    const request = {
      type: 'initAsteroids',
      id: 'owner',
      data: { asteroidCount: 999_999 },
    };
    core.handleClientMessage(request, otherWs);
    core.handleClientMessage(request, unjoinedWs);
    expect(engine.getAsteroidCount()).toBe(0);

    core.handleClientMessage(request, ownerWs);
    expect(engine.getAsteroidCount()).toBeGreaterThan(0);
  });

  test('a rammed rubble rock does not announce a cooperative split', () => {
    engine = new GameEngine(43);
    const pilot = engine.addPlayer('pilot', 'Pilot', mockWs(), { x: 0, y: 0 });
    pilot.spawnProtectionTimer = undefined;
    for (const asteroid of engine.getAllAsteroids()) {
      engine.removeAsteroid(asteroid.id);
    }
    const rubble = addRubble(engine);

    const results = engine.resolveAuthoritativeCombat(1_000);
    const result = results.find((entry) => entry.destroyedAsteroidId === rubble.id);

    expect(result).toBeDefined();
    expect(result?.collabSplit).toBe(false);
    expect(result?.newAsteroids).toEqual([]);
  });
});
