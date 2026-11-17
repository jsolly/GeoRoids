/* @vitest-environment node */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test, vi } from 'vitest';
import { BeltCrawlerManager } from '../../../server/core/BeltCrawlerManager';
import { EntityManager } from '../../../server/core/EntityManager';
import { GameEngine } from '../../../server/core/GameEngine';
import { HiveEncounters } from '../../../server/core/HiveEncounters';
import { RNGService } from '../../../server/core/RNGService';
import { ServerClock } from '../../../server/core/ServerClock';
import { SpiderPopulationBudget } from '../../../server/core/SpiderPopulationBudget';
import { TerrainSpiderManager } from '../../../server/core/TerrainSpiderManager';
import { WorldHazards } from '../../../server/core/WorldHazards';
import { AsteroidSpatialIndex } from '../../../server/world/AsteroidSpatialIndex';
import { CooperativeCampaign } from '../../../server/world/CooperativeCampaign';
import {
  legacyWorldDigest,
  migrateCooperativeWorld,
} from '../../../server/world/cooperativeSchema';
import { InlineWorldPersistence } from '../../../server/world/InlineWorldPersistence';
import { WorldStore } from '../../../server/world/WorldStore';
import { logger } from '../../../setup/serverLogger';
import { AI_SHIPS } from '../../../shared/aiShips';
import { GAME } from '../../../shared/constants/gameplay';
import { COOPERATIVE } from '../../../shared/cooperativeRules';
import { frontierSite } from '../../../shared/frontier';
import type { AsteroidData } from '../../../shared-types';
import { RecordingSocket } from '../../support/recordingSocket';
import { spiderAdvanceFixture } from '../../support/spiderAdvanceFixture';

function hosts(): AsteroidData[] {
  return Array.from({ length: 100 }, (_, i) => ({
    id: `occupied-host-${i}`,
    position: { x: 5000 + i * 250, y: 5000 },
    velocity: { x: 0, y: 0 },
    size: 100,
    health: 100,
    maxHealth: 100,
    rotation: 0,
    angularVelocity: 0,
    jaggedness: 0,
    vertices: 4,
    offsets: [1, 1, 1, 1],
    beltCrawlerIds: [`occupant-${i}`],
    beltCrawlerHealth: [17],
  }));
}

test('activating a crowded belt sleeps excess bodies without killing their persisted occupants', () => {
  const rocks = hosts();
  const index = new AsteroidSpatialIndex(rocks);
  const crawlers = new BeltCrawlerManager();
  crawlers.advance({ index, hosts: rocks, players: [], nowFrame: 1 });
  expect(crawlers.snapshot()).toHaveLength(96);
  const saved = rocks.map((rock) => ({
    ids: [...(rock.beltCrawlerIds ?? [])],
    health: [...(rock.beltCrawlerHealth ?? [])],
  }));
  crawlers.setPopulationLimit(36);
  crawlers.advance({ index, hosts: rocks, players: [], nowFrame: 2 });
  expect(crawlers.snapshot()).toHaveLength(36);
  expect(
    rocks.map((rock) => ({ ids: rock.beltCrawlerIds, health: rock.beltCrawlerHealth }))
  ).toEqual(saved);
  crawlers.setPopulationLimit(96);
  crawlers.advance({ index, hosts: rocks, players: [], nowFrame: 3 });
  expect(crawlers.snapshot()).toHaveLength(96);
  expect(crawlers.snapshot().every((body) => body.health === 17)).toBe(true);
});

test('an inactive campaign leaves awake belt occupants and ordinary spiders at their existing capacity', () => {
  const rocks = hosts();
  const crawlers = new BeltCrawlerManager();
  crawlers.advance({
    index: new AsteroidSpatialIndex(rocks),
    hosts: rocks,
    players: [],
    nowFrame: 1,
  });
  const spiders = new TerrainSpiderManager(() => 0.5);
  for (let index = 0; index < 48; index++) {
    spiders.spawnSpider({ x: 5000 + index, y: 5000 });
  }
  const occupants = crawlers.snapshot().map((body) => body.id);
  const guards = spiders.snapshot().spiders.map((body) => body.id);
  expect(occupants).toHaveLength(96);
  expect(guards).toHaveLength(48);
  const campaign = new CooperativeCampaign();
  const budget = new SpiderPopulationBudget({ campaign, spiders, crawlers });
  const actors = new EntityManager(new RNGService(82));
  actors.addPlayer('pilot', 'Pilot', new RecordingSocket(), { x: 12_500, y: 2500 });
  const hives = new HiveEncounters({ campaign, population: budget, spiders, actors });
  const reads = vi.spyOn(actors, 'getAllEntities');
  const hazards = new WorldHazards({
    campaign,
    population: budget,
    spiders,
    actors,
    hit: () => {
      throw new Error('An inactive campaign cannot damage a pilot');
    },
  });

  try {
    budget.refresh();
    hazards.advance(0);
    hives.advance(1, 0);

    expect(crawlers.snapshot().map((body) => body.id)).toEqual(occupants);
    expect(spiders.snapshot().spiders.map((body) => body.id)).toEqual(guards);
    const released = guards[0];
    if (!released) {
      throw new Error('The crowded ordinary field has no guard to release');
    }
    spiders.removeSpider(released);
    hazards.advance(1000);
    hives.advance(61, 1000);
    expect(hazards.swarmCount()).toBe(0);
    expect(spiders.snapshot().spiders.map((body) => body.id)).toEqual(
      guards.filter((id) => id !== released)
    );
    hazards.advance(1_800_000);
    hives.advance(121, 1_800_000);
    expect(hives.snapshot(1_800_000)).toEqual([]);
    expect(hazards.snapshot()).toEqual([]);
    // The real registry allocates its full actor array on every read, even with no event.
    expect(reads).not.toHaveBeenCalled();
  } finally {
    reads.mockRestore();
  }
});

test('a crowded belt keeps ordinary guards and swarm capacity as both populations change', () => {
  const rocks = hosts();
  const index = new AsteroidSpatialIndex(rocks);
  const crawlers = new BeltCrawlerManager();
  crawlers.advance({ index, hosts: rocks, players: [], nowFrame: 1 });
  const spiders = new TerrainSpiderManager(() => 0.5);
  for (let count = 0; count < 12; count++) {
    spiders.spawnSpider({ x: 5000 + count, y: 5000 });
  }
  expect(crawlers.population).toBe(96);
  expect(spiders.ordinaryCount()).toBe(12);
  const budget = new SpiderPopulationBudget({
    campaign: new CooperativeCampaign({
      schemaVersion: COOPERATIVE.schemaVersion,
      activated: true,
      records: [],
    }),
    spiders,
    crawlers,
  });

  budget.refresh();

  expect(crawlers.population).toBe(24);
  expect(spiders.ordinaryCount()).toBe(12);
  const swarm = Array.from({ length: 13 }, (_, count) =>
    spiders.spawnSpider({ x: 5100 + count, y: 5000 }, 0, true)
  );
  expect(swarm.filter((body) => body !== null)).toHaveLength(12);
  expect(swarm[12]).toBeNull();
  expect(spiders.getBodies()).toHaveLength(24);
  expect(spiders.spawnSpider({ x: 5200, y: 5000 })).toBeNull();

  crawlers.clear();
  budget.refresh();
  for (let count = 0; count < 24; count++) {
    spiders.spawnSpider({ x: 5300 + count, y: 5000 });
  }
  expect(spiders.ordinaryCount()).toBe(36);
  expect(spiders.getBodies()).toHaveLength(48);
  budget.refresh();
  crawlers.advance({ index, hosts: rocks, players: [], nowFrame: 2 });
  expect(crawlers.population).toBe(0);

  spiders.clear();
  budget.refresh();
  crawlers.advance({ index, hosts: rocks, players: [], nowFrame: 3 });
  expect(crawlers.population).toBe(36);
  budget.refresh();
  expect(spiders.spawnSpider({ x: 5400, y: 5000 })).toBeNull();
  expect(spiders.spawnSpider({ x: 5400, y: 5000 }, 0, true)).not.toBeNull();
});

test('hive births respect the refreshed shared budget before consuming an ordinary slot', () => {
  const site = frontierSite('frontier:2,0');
  if (!site) {
    throw new Error('The initial frontier is missing');
  }
  const actors = new EntityManager(new RNGService(82));
  actors.addPlayer('pilot', 'Pilot', new RecordingSocket(), site.position);
  const campaign = new CooperativeCampaign({ schemaVersion: 1, activated: true, records: [] });
  const spiders = new TerrainSpiderManager(() => 0.5);
  const crawlers = new BeltCrawlerManager();
  const population = new SpiderPopulationBudget({ campaign, spiders, crawlers });
  const hives = new HiveEncounters({ campaign, spiders, population, actors });
  hives.advance(1, 1000);
  const hive = campaign.get('hive', site.id);
  if (hive === undefined) {
    throw new Error('The connected pilot did not wake its hive');
  }
  hive.birthFramesLeft = 1;
  campaign.set(hive);
  const ordinary = new Set<string>();
  for (let count = 0; count < 12; count++) {
    const spider = spiders.spawnSpider({ x: 5000 + count, y: 5000 });
    if (!spider) {
      throw new Error('The ordinary field filled before its twelve guards');
    }
    ordinary.add(spider.id);
  }
  const rocks = hosts();
  crawlers.setPopulationLimit(96);
  crawlers.advance({
    index: new AsteroidSpatialIndex(rocks),
    hosts: rocks,
    players: [],
    nowFrame: 1,
  });
  spiders.setPopulationLimit(48, 48);
  expect(crawlers.population).toBe(96);
  expect(spiders.ordinaryCount()).toBe(12);

  hives.advance(2, 1017);

  expect(crawlers.population).toBe(24);
  expect(new Set(spiders.getBodies().map((spider) => spider.id))).toEqual(ordinary);
  expect(campaign.get('hive', site.id)?.birthFramesLeft).toBe(0);
});

function withActivatedEngine(run: (engine: GameEngine, elapsed: { value: number }) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'campaign-budget-'));
  const path = join(dir, 'world.sqlite');
  try {
    new WorldStore(path).close();
    const db = new DatabaseSync(path);
    try {
      migrateCooperativeWorld(db, legacyWorldDigest(db));
      db.exec('UPDATE cooperative_schema SET activated=1');
    } finally {
      db.close();
    }
    const store = new WorldStore(path);
    try {
      const elapsed = { value: 0 };
      const clock = new ServerClock({ wallNow: () => 0, monotonicNow: () => elapsed.value });
      const engine = new GameEngine(82, clock, new InlineWorldPersistence(store));
      try {
        run(engine, elapsed);
      } finally {
        engine.stopGameLoop();
      }
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('the full campaign stage waits for its refresh frame and skips combat-only and paused frames', () => {
  withActivatedEngine((engine, elapsed) => {
    const site = frontierSite('frontier:2,0');
    if (!site) {
      throw new Error('The initial frontier is missing');
    }
    const socket = new RecordingSocket();
    const pilot = engine.addPlayer('pilot', 'Pilot', socket, site.position);
    pilot.overlayHold = true;
    expect(engine.pilotSessions.register({ actor: pilot, socket }).ok).toBe(true);
    engine.advanceCombatFrame();
    expect(engine.getBroadcastState().campaign?.hives).toEqual([]);
    for (let frame = 2; frame <= 60; frame++) {
      elapsed.value += 1000 / GAME.FPS;
      pilot.lastUpdate = elapsed.value;
      engine.advanceOneFrame();
    }
    expect(engine.getBroadcastState().campaign?.hives).toEqual([]);

    elapsed.value += 1000 / GAME.FPS;
    engine.advanceOneFrame();
    expect(
      engine.getBroadcastState().campaign?.hives.find((hive) => hive.id === site.id)
        ?.birthFramesLeft
    ).toBe(COOPERATIVE.birthFrames - 1);
    engine.advanceCombatFrame();
    expect(
      engine.getBroadcastState().campaign?.hives.find((hive) => hive.id === site.id)
        ?.birthFramesLeft
    ).toBe(COOPERATIVE.birthFrames - 1);
    elapsed.value += 1000 / GAME.FPS;
    engine.advanceOneFrame();
    expect(
      engine.getBroadcastState().campaign?.hives.find((hive) => hive.id === site.id)
        ?.birthFramesLeft
    ).toBe(COOPERATIVE.birthFrames - 2);

    engine.removePlayer(pilot.id);
    expect(engine.isGamePaused()).toBe(true);
    elapsed.value += 1000 / GAME.FPS;
    engine.advanceOneFrame();
    expect(
      engine.getBroadcastState().campaign?.hives.find((hive) => hive.id === site.id)
        ?.birthFramesLeft
    ).toBe(COOPERATIVE.birthFrames - 2);
  });
});

test('only the full frame creates meteors and clears them after the last pilot leaves', () => {
  withActivatedEngine((engine, elapsed) => {
    engine.addPlayer('pilot', 'Pilot', new RecordingSocket(), { x: 5000, y: 5000 });
    elapsed.value = 1_800_000;

    engine.advanceCombatFrame();
    expect(engine.getBroadcastState().campaign?.meteors).toEqual([]);
    engine.advanceOneFrame();
    expect(engine.getBroadcastState().campaign?.meteors).toHaveLength(1);

    engine.removePlayer('pilot');
    expect(engine.isGamePaused()).toBe(true);
    expect(engine.getBroadcastState().campaign?.meteors).toHaveLength(1);
    engine.advanceCombatFrame();
    expect(engine.getBroadcastState().campaign?.meteors).toHaveLength(1);
    elapsed.value += 17;
    engine.advanceOneFrame();
    expect(engine.getBroadcastState().campaign?.meteors).toEqual([]);
    expect(engine.isGamePaused()).toBe(true);
  });
});

test('a live fleet worker receives the normal meteor hit through the full engine actor view', () => {
  withActivatedEngine((engine, elapsed) => {
    engine.prepareDiagnosticWorld('combat');
    for (const rock of engine.getAllAsteroids()) {
      engine.asteroidLifecycle.remove(rock.id);
    }
    engine.parkSatellitePickups();
    const socket = new RecordingSocket();
    const pilot = engine.addPlayer('pilot', 'Pilot', socket, { x: 5000, y: 5000 });
    pilot.overlayHold = true;
    expect(engine.pilotSessions.register({ actor: pilot, socket }).ok).toBe(true);
    for (let frame = 0; frame < AI_SHIPS.spawnDelayFrames; frame++) {
      elapsed.value += 1000 / GAME.FPS;
      pilot.lastUpdate = elapsed.value;
      engine.advanceOneFrame();
    }
    const row = engine.getSnapshotState().entities.find((actor) => actor.botRole === 'worker');
    if (!row) {
      throw new Error('The live fleet did not spawn its worker');
    }
    const worker = engine.getPlayer(row.id);
    if (!worker) {
      throw new Error('The worker is missing from the authoritative registry');
    }
    expect(worker.ws).toBeUndefined();
    expect(engine.getAllPlayers().map((actor) => actor.id)).toEqual(['pilot']);
    elapsed.value = 1_800_000;
    pilot.lastUpdate = elapsed.value;
    engine.advanceOneFrame();
    const meteor = engine.getBroadcastState().campaign?.meteors[0];
    if (!meteor) {
      throw new Error('The connected pilot did not admit a meteor');
    }
    worker.position = { ...meteor.position };
    worker.velocity = { x: 0, y: 0 };
    worker.cargo = 0;
    worker.spawnProtectionTimer = 0;
    const health = worker.health;

    const info = vi.spyOn(logger, 'info');
    try {
      elapsed.value += 17;
      pilot.lastUpdate = elapsed.value;
      engine.advanceOneFrame();

      expect(engine.getPlayer(row.id)).toBe(worker);
      expect(worker.health).toBe(health - 50);
      expect(info).toHaveBeenCalledWith(
        'STATE',
        'damage_applied',
        expect.objectContaining({
          playerId: worker.id,
          attackerId: 'asteroid',
          damage: 50,
          healthBefore: health,
          healthAfter: health - 50,
        })
      );
    } finally {
      info.mockRestore();
    }
  });
});

test('the first swarm actor has a reserved slot before a crowded ordinary field advances', () => {
  withActivatedEngine((engine) => {
    const pilot = engine.addPlayer('pilot', 'Pilot', new RecordingSocket(), { x: 5000, y: 5000 });
    pilot.position = { x: 5000, y: 5000 };
    const ordinaryIds = new Set(
      Array.from({ length: 48 }, (_, count) =>
        engine.spawnTerrainSpider({ x: 5100 + count, y: 5000 })
      )
        .filter((body) => body !== null)
        .map((body) => body.id)
    );
    expect(ordinaryIds.size).toBe(48);

    engine.advanceOneFrame();

    const bodies = engine.getSpiderField().spiders;
    expect(bodies.filter((body) => ordinaryIds.has(body.id))).toHaveLength(36);
    const arrivals = bodies.filter((body) => !ordinaryIds.has(body.id));
    expect(arrivals).toHaveLength(1);
    expect(arrivals[0]?.crawler).toBeUndefined();
  });
});

test('a combat-only frame budgets the ordinary field before distant spiders leave', () => {
  withActivatedEngine((engine) => {
    const pilot = engine.addPlayer('pilot', 'Pilot', new RecordingSocket(), { x: 5000, y: 5000 });
    pilot.position = { x: 5000, y: 5000 };
    engine.prepareDiagnosticWorld('combat');
    for (const rock of engine.getAllAsteroids()) {
      engine.asteroidLifecycle.remove(rock.id);
    }
    engine.parkSatellitePickups();
    const distant = new Set(
      Array.from({ length: 36 }, (_, count) =>
        engine.spawnTerrainSpider({ x: 15000 + count, y: 15000 })
      )
        .filter((body) => body !== null)
        .map((body) => body.id)
    );
    const nearby = new Set(
      Array.from({ length: 12 }, (_, count) =>
        engine.spawnTerrainSpider({ x: 5100 + count, y: 5000 })
      )
        .filter((body) => body !== null)
        .map((body) => body.id)
    );
    const initial = engine.getSpiderField().spiders;
    expect(initial.filter((body) => distant.has(body.id))).toHaveLength(36);
    expect(initial.filter((body) => nearby.has(body.id))).toHaveLength(12);

    engine.advanceCombatFrame();

    const bodies = engine.getSpiderField().spiders;
    expect(bodies.filter((body) => distant.has(body.id))).toHaveLength(0);
    expect(bodies.filter((body) => nearby.has(body.id))).toHaveLength(0);
  });
});

test('departing terrain spiders free belt slots in the same frame, and waking occupants consume them', () => {
  withActivatedEngine((engine) => {
    const pilot = engine.addPlayer('pilot', 'Pilot', new RecordingSocket(), { x: 5000, y: 5000 });
    pilot.position = { x: 5000, y: 5000 };
    engine.prepareDiagnosticWorld('combat');
    for (const rock of engine.getAllAsteroids()) {
      engine.asteroidLifecycle.remove(rock.id);
    }
    engine.parkSatellitePickups();
    const departing = new Set(
      Array.from({ length: 36 }, (_, count) =>
        engine.spawnTerrainSpider({ x: 15000 + count, y: 15000 })
      )
        .filter((body) => body !== null)
        .map((body) => body.id)
    );
    expect(departing.size).toBe(36);
    for (const [count, rock] of hosts().slice(0, 36).entries()) {
      rock.position = { x: 4375 + (count % 6) * 250, y: 4375 + Math.floor(count / 6) * 250 };
      engine.asteroidLifecycle.insert(rock);
    }

    engine.advanceOneFrame();

    const bodies = engine.getSpiderField().spiders;
    expect(bodies.filter((body) => departing.has(body.id))).toHaveLength(0);
    expect(bodies.filter((body) => body.crawler)).toHaveLength(36);
    expect(engine.spawnTerrainSpider({ x: 5200, y: 5000 })).toBeNull();
  });
});

test('the real activated engine reserves twelve swarm slots before admitting crowded belt bodies', () => {
  withActivatedEngine((engine, elapsed) => {
    const pilot = engine.addPlayer('pilot', 'Pilot', new RecordingSocket(), { x: 5000, y: 5000 });
    pilot.position = { x: 5000, y: 5000 };
    for (const rock of hosts()) {
      engine.asteroidLifecycle.insert(rock);
    }
    // Hazards run before ordinary spawners; each frame admits at most one event actor.
    for (let second = 0; second < 12; second++) {
      elapsed.value = second * 1000;
      engine.advanceOneFrame();
    }
    const spiders = engine.getSpiderField().spiders;
    expect(spiders.filter((spider) => spider.crawler).length).toBeGreaterThan(0);
    expect(spiders.filter((spider) => spider.crawler).length).toBeLessThanOrEqual(36);
    expect(spiders).toHaveLength(48);
  });
});

test.each(['travel', 'suspend'] as const)(
  '%s removes event reservations so ordinary refill leaves the next swarm twelve slots',
  (mode) => {
    const engine = new GameEngine(82);
    try {
      const pilot = engine.addPlayer('pilot', 'Pilot', new RecordingSocket(), { x: 5000, y: 5000 });
      pilot.position = { x: 5000, y: 5000 };
      const spiders = new TerrainSpiderManager(() => 0.5);
      spiders.setPopulationLimit(36, 48);
      const campaign = new CooperativeCampaign({
        schemaVersion: COOPERATIVE.schemaVersion,
        activated: true,
        records: [],
      });
      const hazards = new WorldHazards({
        campaign,
        spiders,
        population: new SpiderPopulationBudget({
          campaign,
          spiders,
          crawlers: new BeltCrawlerManager(),
        }),
        actors: { getAllEntities: () => [pilot] },
        hit: () => {
          throw new Error('Swarm damage belongs to combat');
        },
      });
      for (let second = 0; second < 12; second++) {
        hazards.advance(second * 1000);
      }
      expect(hazards.swarmCount()).toBe(12);
      if (mode === 'suspend') {
        spiders.suspend();
      } else {
        spiders.advance(
          spiderAdvanceFixture({
            nowFrame: 1,
            players: [{ ...pilot, position: { x: -15000, y: -15000 }, radius: 18 }],
          })
        );
      }
      expect(spiders.snapshot().spiders).toHaveLength(0);
      for (let i = 0; i < 48; i++) {
        spiders.spawnSpider({ x: 5000 + i, y: 5000 });
      }
      expect(spiders.snapshot().spiders).toHaveLength(36);
      hazards.advance(180_000);
      for (let second = 0; second < 12; second++) {
        hazards.advance(3_600_000 + second * 1000);
      }
      expect(hazards.swarmCount()).toBe(12);
      expect(spiders.snapshot().spiders).toHaveLength(48);
    } finally {
      engine.stopGameLoop();
    }
  }
);
