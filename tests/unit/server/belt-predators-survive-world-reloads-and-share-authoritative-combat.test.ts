/* @vitest-environment node */
import assert from 'node:assert/strict';
import { expect, test } from 'vitest';
import { GameEngine } from '../../../server/core/GameEngine';
import { InlineWorldPersistence } from '../../../server/world/InlineWorldPersistence';
import { WorldStore } from '../../../server/world/WorldStore';
import { beltSlotForAsteroid, beltSlotPosition } from '../../../shared/asteroidBelt';
import { BELT_CRAWLER } from '../../../shared/beltCrawler';
import { captureSnapshot } from '../../../shared/snapshotProtocol';
import type { AsteroidData } from '../../../shared-types';
import { DAMAGE } from '../../../src/constants';
import { RecordingSocket } from '../../support/recordingSocket';

function addPilot(engine: GameEngine) {
  const player = engine.addPlayer('miner', 'Miner', new RecordingSocket(), beltSlotPosition(60));
  player.spawnProtectionTimer = 0;
  return player;
}

test('a natural belt shares valid snapshots with roaming spiders and retains crawler wounds across a saved-world reload', () => {
  const store = new WorldStore(':memory:');
  const engine = new GameEngine(82, undefined, new InlineWorldPersistence(store));
  let restarted: GameEngine | undefined;
  try {
    const player = addPilot(engine);
    engine.ensureAsteroidField();
    engine.advanceCombatFrame();
    const crawler = engine.getSpiderField().spiders.find((spider) => spider.crawler);
    assert(crawler?.crawler);
    const host = engine.getAsteroid(crawler.crawler.hostId);
    assert(host);
    expect(beltSlotForAsteroid(host.id)).toBeDefined();
    const wound = BELT_CRAWLER.MAX_HEALTH - DAMAGE.LASER_HIT * 0.5;
    host.beltCrawlerHealth = [wound];
    engine.spawnTerrainSpider({ x: player.position.x, y: player.position.y + 400 });
    engine.advanceCombatFrame();
    expect(engine.getSpiderField().spiders.some((spider) => !spider.crawler)).toBe(true);
    expect(() =>
      captureSnapshot({
        ...engine.getGameState(),
        collabTags: [],
        playerProjectiles: engine.getPlayerProjectiles(),
      })
    ).not.toThrow();
    engine.checkpointWorld();
    engine.stopGameLoop();
    restarted = new GameEngine(99, undefined, new InlineWorldPersistence(store));
    addPilot(restarted);
    restarted.ensureAsteroidField();
    restarted.advanceCombatFrame();
    const recovered = restarted.getAsteroid(host.id);
    expect(recovered?.beltCrawlerHealth).toEqual([wound]);
    const survivors = restarted
      .getSpiderField()
      .spiders.filter((spider) => spider.crawler?.hostId === host.id);
    expect(survivors).toHaveLength(1);
    expect(survivors[0]?.health).toBe(wound);
  } finally {
    engine.stopGameLoop();
    restarted?.stopGameLoop();
    store.close();
  }
});

test('authoritative laser ordering hits an exposed crawler before its host and removes its dead body', () => {
  const store = new WorldStore(':memory:');
  const engine = new GameEngine(82, undefined, new InlineWorldPersistence(store));
  try {
    const player = addPilot(engine);
    for (const rock of engine.getAllAsteroids()) {
      engine.removeAsteroid(rock.id);
    }
    engine.clearSpiderField();
    const rock: AsteroidData = {
      id: 'belt-82-0-0',
      position: { x: 10000, y: 10000 },
      velocity: { x: 0, y: 0 },
      size: 100,
      health: 150,
      maxHealth: 150,
      rotation: 0,
      angularVelocity: 0,
      jaggedness: 0,
      vertices: 4,
      offsets: [1, 1, 1, 1],
    };
    engine.addAsteroid(rock);
    player.position = { x: 10500, y: 10000 };
    engine.advanceCombatFrame();
    const crawler = engine
      .getSpiderField()
      .spiders.find((spider) => spider.crawler?.hostId === rock.id && spider.id.endsWith(':0'));
    assert(crawler);
    const shot = engine.spawnLaser(
      player.id,
      { x: crawler.position.x + 45, y: crawler.position.y },
      { x: -80, y: 0 }
    );
    assert(shot);
    engine.advanceLasersAndResolveHits();
    expect(shot.hasExploded).toBe(true);
    expect(engine.getAsteroid(rock.id)?.health).toBe(150);
    expect(engine.getSpiderField().spiders.some((spider) => spider.id === crawler.id)).toBe(false);
    expect(engine.getAsteroid(rock.id)?.beltCrawlerHealth?.[0]).toBe(0);
  } finally {
    engine.stopGameLoop();
    store.close();
  }
});

test('destroying the host cancels a crawler bite queued earlier in the same authoritative frame', () => {
  const store = new WorldStore(':memory:');
  const engine = new GameEngine(82, undefined, new InlineWorldPersistence(store));
  try {
    const player = addPilot(engine);
    for (const rock of engine.getAllAsteroids()) {
      engine.removeAsteroid(rock.id);
    }
    engine.clearSpiderField();
    const rock: AsteroidData = {
      id: 'belt-82-0-0',
      position: { x: 10000, y: 10000 },
      velocity: { x: 0, y: 0 },
      size: 100,
      health: 150,
      maxHealth: 150,
      rotation: 0,
      angularVelocity: 0,
      jaggedness: 0,
      vertices: 4,
      offsets: [1, 1, 1, 1],
    };
    engine.addAsteroid(rock);
    player.position = { x: 10165, y: 9990 };
    for (let frame = 0; frame < BELT_CRAWLER.WINDUP_FRAMES + 10; frame++) {
      engine.advanceCombatFrame();
    }
    expect(
      engine.getSpiderField().spiders.some((spider) => spider.crawler?.phase === 'lunging')
    ).toBe(true);
    const health = player.health;
    engine.removeAsteroid(rock.id);
    engine.resolveAuthoritativeCombat();
    expect(player.health).toBe(health);
    engine.advanceCombatFrame();
    expect(engine.getSpiderField().spiders.filter((spider) => spider.crawler)).toEqual([]);
  } finally {
    engine.stopGameLoop();
    store.close();
  }
});

test('the last miner leaving immediately after removing a belt rock saves its recovery deadline', () => {
  const store = new WorldStore(':memory:');
  const engine = new GameEngine(82, undefined, new InlineWorldPersistence(store));
  try {
    const player = addPilot(engine);
    engine.ensureAsteroidField();
    const host = engine
      .getAllAsteroids()
      .find((rock) => beltSlotForAsteroid(rock.id) !== undefined);
    assert(host);
    const slot = beltSlotForAsteroid(host.id);
    engine.removeAsteroid(host.id);
    engine.removePlayer(player.id);
    const savedSlot = store.load().world?.asteroidBelt?.find((entry) => entry.slot === slot);
    expect(savedSlot?.recoverAt).toEqual(expect.any(Number));
    expect(savedSlot?.generation).toBe(0);
  } finally {
    engine.stopGameLoop();
    store.close();
  }
});

test('mining a host transfers a wounded crawler and a database reload preserves its identity on the destination', () => {
  const store = new WorldStore(':memory:');
  const engine = new GameEngine(82, undefined, new InlineWorldPersistence(store));
  let restarted: GameEngine | undefined;
  try {
    const player = addPilot(engine);
    for (const rock of engine.getAllAsteroids()) {
      engine.removeAsteroid(rock.id);
    }
    engine.clearSpiderField();
    const home = beltSlotPosition(60);
    const rock: AsteroidData = {
      id: 'belt-82-60-0',
      position: home,
      velocity: { x: 0, y: 0 },
      size: 30,
      health: 25,
      maxHealth: 150,
      rotation: 0,
      angularVelocity: 0,
      jaggedness: 0,
      vertices: 4,
      offsets: [1, 1, 1, 1],
      material: 'metal',
      beltCrawlerHealth: [50], // Older than one laser hit; adoption clamps it.
    };
    const destination: AsteroidData = {
      ...rock,
      id: 'escape-destination',
      position: { x: home.x + 200, y: home.y },
      health: 150,
    };
    delete destination.beltCrawlerHealth;
    engine.addAsteroid(rock);
    engine.addAsteroid(destination);
    player.position = { x: home.x - 500, y: home.y };
    engine.advanceCombatFrame();
    const before = engine.getSpiderField().spiders.find((body) => body.crawler?.hostId === rock.id);
    assert(before);
    expect(engine.handleAsteroidHit(rock.id, player.id, 'laser', undefined, 25).outcome).toBe(
      'destroyed'
    );
    expect(engine.getSpiderField().spiders.find((body) => body.id === before.id)).toMatchObject({
      health: BELT_CRAWLER.MAX_HEALTH,
      crawler: { phase: 'escaping', hostId: destination.id },
    });
    engine.checkpointWorld();
    engine.stopGameLoop();
    restarted = new GameEngine(99, undefined, new InlineWorldPersistence(store));
    addPilot(restarted);
    restarted.ensureAsteroidField();
    restarted.advanceCombatFrame();
    expect(restarted.getSpiderField().spiders.find((body) => body.id === before.id)).toMatchObject({
      health: BELT_CRAWLER.MAX_HEALTH,
      crawler: { hostId: destination.id },
    });
    expect(restarted.getSpiderField().spiders.filter((body) => body.id === before.id)).toHaveLength(
      1
    );
    const snapshot = {
      ...restarted.getGameState(),
      collabTags: [],
      playerProjectiles: restarted.getPlayerProjectiles(),
    };
    expect(() => captureSnapshot(snapshot)).not.toThrow();
  } finally {
    engine.stopGameLoop();
    restarted?.stopGameLoop();
    store.close();
  }
});
