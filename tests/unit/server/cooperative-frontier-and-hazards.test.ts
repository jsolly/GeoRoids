/* @vitest-environment node */
import { afterEach, expect, test } from 'vitest';
import { BeltCrawlerManager } from '../../../server/core/BeltCrawlerManager';
import { EntityManager } from '../../../server/core/EntityManager';
import { GameEngine } from '../../../server/core/GameEngine';
import { HiveEncounters } from '../../../server/core/HiveEncounters';
import { RNGService } from '../../../server/core/RNGService';
import { SpiderPopulationBudget } from '../../../server/core/SpiderPopulationBudget';
import { TerrainSpiderManager } from '../../../server/core/TerrainSpiderManager';
import { WorldHazards } from '../../../server/core/WorldHazards';
import { AsteroidSpatialIndex } from '../../../server/world/AsteroidSpatialIndex';
import { CooperativeCampaign } from '../../../server/world/CooperativeCampaign';
import { COOPERATIVE } from '../../../shared/cooperativeRules';
import { frontierSite, frontierSitesNear, sacPosition } from '../../../shared/frontier';
import { hazardPhase } from '../../../shared/worldHazards';
import { asteroidRow } from '../../support/asteroid-row';
import { RecordingSocket } from '../../support/recordingSocket';

const engines: GameEngine[] = [];
afterEach(() => {
  for (const engine of engines.splice(0)) {
    engine.stopGameLoop();
  }
});
function scene() {
  const engine = new GameEngine(82);
  engines.push(engine);
  const site = frontierSite('frontier:2,0');
  if (!site) {
    throw new Error('Fixture site');
  }
  const socket = new RecordingSocket();
  const pilot = engine.addPlayer('hauler', 'Hauler', socket, site.position, 'hauler');
  pilot.position = { x: site.position.x + 150, y: site.position.y };
  pilot.haulerUtility = 'tow_cable';
  const campaign = new CooperativeCampaign({ schemaVersion: 1, activated: true, records: [] });
  const spiders = new TerrainSpiderManager(() => 0.5);
  const crawlers = new BeltCrawlerManager();
  const population = new SpiderPopulationBudget({ campaign, spiders, crawlers });
  const hives = new HiveEncounters({ campaign, spiders, population, actors: engine.entityManager });
  hives.advance(1, 1000);
  return { engine, site, pilot, socket, campaign, spiders, hives, crawlers, population };
}

test('the first hive birth includes the first refresh frame exactly once', () => {
  const { site, campaign, spiders, hives } = scene();
  expect(campaign.get('hive', site.id)?.birthFramesLeft).toBe(COOPERATIVE.birthFrames - 1);
  for (let frame = 2; frame < COOPERATIVE.birthFrames; frame++) {
    hives.advance(frame, 1000 + frame);
  }
  expect(spiders.getBodies()).toHaveLength(0);
  expect(campaign.get('hive', site.id)?.birthFramesLeft).toBe(1);

  hives.advance(COOPERATIVE.birthFrames, 1000 + COOPERATIVE.birthFrames);

  expect(spiders.getBodies()).toHaveLength(1);
  expect(campaign.get('hive', site.id)?.birthFramesLeft).toBe(COOPERATIVE.birthFrames);
});

test('hives refresh on frame 61 from fresh humans, including a connected exploding pilot', () => {
  const { engine, site, hives } = scene();
  const distant = frontierSite('frontier:-3,0');
  if (distant?.frontier !== 'initial') {
    throw new Error('The distant initial frontier is missing');
  }
  expect(
    Math.hypot(distant.position.x - site.position.x, distant.position.y - site.position.y)
  ).toBe(25_000);
  const other = engine.addPlayer('other', 'Other', new RecordingSocket(), distant.position);
  other.health = 0;
  other.exploding = true;

  hives.advance(2, 1001);
  expect(hives.snapshot(1001).map((hive) => hive.id)).toEqual([site.id]);
  hives.advance(60, 1059);
  expect(hives.snapshot(1059).map((hive) => hive.id)).toEqual([site.id]);
  hives.advance(61, 1060);
  expect(new Set(hives.snapshot(1060).map((hive) => hive.id))).toEqual(
    new Set([site.id, distant.id])
  );
  expect(hives.snapshot(1060).find((hive) => hive.id === distant.id)?.birthFramesLeft).toBe(
    COOPERATIVE.birthFrames - 1
  );

  engine.removePlayer(other.id);
  hives.advance(62, 1061);
  expect(hives.snapshot(1061).some((hive) => hive.id === distant.id)).toBe(true);
  hives.advance(121, 1120);
  expect(hives.snapshot(1120).map((hive) => hive.id)).toEqual([site.id]);
});

test('shield blocks a lone gun; a solo tow exposes 500 HP and death permanently removes owned births', () => {
  const { engine, site, pilot, socket, campaign, spiders, hives, crawlers } = scene();
  expect(hives.hit(site.id, pilot, 500, 1000)).toBe(false);
  for (let i = 0; i < COOPERATIVE.birthFrames * 7; i++) {
    hives.advance(i + 2, 1000 + i);
  }
  expect(spiders.snapshot().spiders).toHaveLength(6);
  pilot.harpoonTargetId = site.id;
  hives.advance(COOPERATIVE.birthFrames * 7 + 2, 5000);
  expect(hives.hit(site.id, pilot, 499, 5000)).toBe(true);
  expect(campaign.get('hive', site.id)?.queenHealth).toBe(1);
  expect(hives.hit(site.id, pilot, 1, 5001)).toBe(true);
  expect(spiders.snapshot().spiders).toHaveLength(0);
  delete pilot.ws;
  hives.advance(COOPERATIVE.birthFrames * 7 + 61, 6000);
  pilot.ws = socket;
  hives.advance(COOPERATIVE.birthFrames * 7 + 121, 7000);
  const restoredCampaign = new CooperativeCampaign({
    schemaVersion: 1,
    activated: true,
    records: structuredClone([...campaign.all()]),
  });
  const restarted = new HiveEncounters({
    campaign: restoredCampaign,
    spiders,
    population: new SpiderPopulationBudget({ campaign: restoredCampaign, spiders, crawlers }),
    actors: engine.entityManager,
  });
  restarted.advance(1, 10_000);
  for (let i = 0; i < 600; i++) {
    restarted.advance(i + 2, 10_000 + i);
  }
  expect(restarted.targetsNear(site.position, 1000).some((target) => target.id === site.id)).toBe(
    false
  );
  expect(spiders.snapshot().spiders).toHaveLength(0);
});

test('different opposite pilots open the shield for two seconds; same-side or stale hits do not', () => {
  const { engine, site, pilot, hives } = scene();
  const other = engine.addPlayer('other', 'Other', new RecordingSocket(), site.position, 'scout');
  other.position = { x: site.position.x + 200, y: site.position.y };
  hives.hit(site.id, pilot, 10, 1000);
  expect(hives.hit(site.id, other, 10, 1001)).toBe(false);
  other.position.x = site.position.x - 200;
  expect(hives.hit(site.id, other, 10, 3000)).toBe(false);
  expect(hives.hit(site.id, pilot, 10, 3001)).toBe(true);
  expect(hives.shieldOpen(site.id, 5000)).toBe(true);
  expect(hives.shieldOpen(site.id, 5001)).toBe(false);
});

test('sacs are 450 units apart, regrow exactly at 20 seconds and stay completed across sleep', () => {
  const { site, pilot, socket, hives, campaign } = scene();
  const a = sacPosition(site.position, 0, 2),
    b = sacPosition(site.position, 1, 2);
  expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeCloseTo(450);
  hives.hit(`${site.id}/sac/0`, pilot, 50, 1000);
  hives.advance(2, 20_999);
  expect(campaign.get('hive', site.id)?.sacs).toEqual([0, 50]);
  hives.advance(3, 21_000);
  expect(campaign.get('hive', site.id)?.sacs).toEqual([50, 50]);
  hives.hit(`${site.id}/sac/0`, pilot, 50, 22_000);
  hives.hit(`${site.id}/sac/1`, pilot, 50, 41_999);
  delete pilot.ws;
  hives.advance(61, 42_000);
  expect(hives.snapshot(42_000)).toEqual([]);
  pilot.ws = socket;
  hives.advance(121, 42_000);
  expect(hives.snapshot(42_000).find((hive) => hive.id === site.id)?.sacs).toEqual([0, 0]);
  hives.advance(122, 80_000);
  expect(campaign.get('hive', site.id)?.sacs).toEqual([0, 0]);
  const expanded = frontierSitesNear({ x: 22500, y: 2500 }, 1000)[0];
  if (!expanded) {
    throw new Error('Expanded fixture');
  }
  pilot.position = expanded.position;
  hives.advance(181, 80_000);
  expect(hives.snapshot(80_000)).toEqual([]);
  campaign.set({
    kind: 'project',
    id: 'deep-scanner',
    deliveredValue: 10_000,
    completedAt: 80_000,
  });
  hives.advance(241, 80_000);
  expect(hives.snapshot(80_000)[0]?.sacs).toEqual([50, 50, 50]);
  const triangle = [0, 1, 2].map((i) => sacPosition(expanded.position, i, 3));
  for (let i = 0; i < 3; i++) {
    const x = triangle[i],
      y = triangle[(i + 1) % 3];
    if (x && y) {
      expect(Math.hypot(x.x - y.x, x.y - y.y)).toBeCloseTo(450);
    }
  }
});

test('UTC warnings and active windows have exact half-hour boundaries', () => {
  expect(hazardPhase(24 * 60_000 + 59_999).phase).toBe('quiet');
  expect(hazardPhase(25 * 60_000).phase).toBe('warning');
  expect(hazardPhase(30 * 60_000)).toEqual({
    phase: 'active',
    kind: 'meteors',
    startsAt: 1_800_000,
    endsAt: 1_980_000,
  });
  expect(hazardPhase(33 * 60_000).phase).toBe('quiet');
  expect(hazardPhase(55 * 60_000).phase).toBe('warning');
  expect(hazardPhase(60 * 60_000).kind).toBe('swarm');
});

test('swarm reserves 12 of 48 slots, expires only its actors and never replays offline windows', () => {
  const { pilot, spiders, campaign, population } = scene();
  spiders.setPopulationLimit(36, 48);
  for (let i = 0; i < 40; i++) {
    spiders.spawnSpider({ x: 5000 + i, y: 5000 });
  }
  expect(spiders.snapshot().spiders).toHaveLength(36);
  const ordinary = spiders.snapshot().spiders.map((s) => s.id);
  let players = [pilot];
  const hazards = new WorldHazards({
    campaign,
    population,
    spiders,
    actors: { getAllEntities: () => players },
    hit: () => {
      throw new Error('Swarm damage belongs to combat');
    },
  });
  for (let i = 0; i < 20; i++) {
    hazards.advance(i * 1000);
  }
  expect(hazards.swarmCount()).toBe(12);
  expect(spiders.snapshot().spiders).toHaveLength(48);
  hazards.advance(180_000);
  expect(spiders.snapshot().spiders.map((s) => s.id)).toEqual(ordinary);
  players = [];
  hazards.advance(3_600_000);
  expect(hazards.swarmCount()).toBe(0);
  players = [pilot];
  hazards.advance(3_700_000);
  expect(hazards.swarmCount()).toBe(1);
  hazards.advance(3_500_000);
  expect(hazards.swarmCount()).toBe(0);
});

test('meteors use normal cargo shielding and expire without changing structures', () => {
  const { engine, pilot, spiders, campaign, population } = scene();
  pilot.spawnProtectionTimer = 0;
  pilot.cargo = 300;
  const before = structuredClone(engine.getGameState().civicModules);
  const health = pilot.health;
  const hazards = new WorldHazards({
    campaign,
    population,
    spiders,
    actors: { getAllEntities: () => [pilot] },
    hit: (id) => engine.shipDamage.apply(id, 'asteroid', 50),
  });
  hazards.advance(1_800_000);
  const meteor = hazards.snapshot()[0];
  if (!meteor) {
    throw new Error('Meteor missing');
  }
  pilot.position = { ...meteor.position };
  hazards.advance(1_800_017);
  expect(pilot.cargo).toBe(0);
  expect(pilot.health).toBe(health - 20);
  hazards.advance(1_980_000);
  expect(hazards.snapshot()).toEqual([]);
  expect(engine.getGameState().civicModules).toEqual(before);
});

test('shrinking ordinary capacity preserves the live swarm as belt occupants refill', () => {
  const { pilot, spiders, campaign, population, crawlers } = scene();
  spiders.setPopulationLimit(36, 48);
  const ordinaryIds = new Set<string>();
  for (let i = 0; i < 36; i++) {
    const guard = spiders.spawnSpider({ x: 5000 + i, y: 5000 });
    if (!guard) {
      throw new Error('The ordinary guard did not fit before the swarm arrived');
    }
    ordinaryIds.add(guard.id);
  }
  expect(ordinaryIds.size).toBe(36);
  const hazards = new WorldHazards({
    campaign,
    population,
    spiders,
    actors: { getAllEntities: () => [pilot] },
    hit: () => {
      throw new Error('Swarm damage belongs to combat');
    },
  });
  for (let i = 0; i < 12; i++) {
    hazards.advance(i * 1000);
  }
  const reservedIds = new Set(
    spiders
      .snapshot()
      .spiders.filter((body) => !ordinaryIds.has(body.id))
      .map((body) => body.id)
  );
  expect(reservedIds.size).toBe(12);
  expect(spiders.snapshot().spiders).toHaveLength(48);

  // Keep the original pressure transition: the newer event actors must survive eviction.
  spiders.setPopulationLimit(24, 36);
  expect(spiders.snapshot().spiders).toHaveLength(36);
  expect(hazards.swarmCount()).toBe(12);
  expect(
    new Set(
      spiders
        .snapshot()
        .spiders.filter((body) => reservedIds.has(body.id))
        .map((body) => body.id)
    )
  ).toEqual(reservedIds);
  expect(spiders.ordinaryCount()).toBe(24);

  population.refresh();
  const rocks = Array.from({ length: 12 }, (_, index) => ({
    ...asteroidRow({ x: 5000 + index * 250, y: 5000 }, 100, `host-${index}`),
    beltCrawlerIds: [`occupant-${index}`],
    beltCrawlerHealth: [17],
  }));
  crawlers.advance({
    index: new AsteroidSpatialIndex(rocks),
    hosts: rocks,
    players: [],
    nowFrame: 1,
  });
  expect(crawlers.population).toBe(12);
  population.refresh();
  hazards.advance(12_000);
  expect(hazards.swarmCount()).toBe(12);
  hazards.advance(180_000);
  expect(spiders.snapshot().spiders).toHaveLength(24);
});

test.each(['downed', 'exploding', 'disconnected', 'transit'] as const)(
  'meteors pass through %s hulls and hit a live bot behind them',
  (state) => {
    const { engine, pilot, spiders, campaign, population } = scene();
    const inactive = engine.addPlayer('inactive', 'Inactive', new RecordingSocket());
    if (state === 'downed') {
      inactive.health = 0;
    }
    if (state === 'exploding') {
      inactive.exploding = true;
    }
    if (state === 'disconnected') {
      delete inactive.ws;
    }
    if (state === 'transit') {
      inactive.furnaceTransit = {
        sourceId: 'source',
        destinationId: 'destination',
        startedAt: 1_800_000,
        durationMs: 1000,
      };
    }
    const bot = new EntityManager(new RNGService(82)).addBot('worker', 'worker', { x: 0, y: 0 });
    const hits: string[] = [];
    const players = [pilot];
    const hazards = new WorldHazards({
      campaign,
      population,
      spiders,
      actors: { getAllEntities: () => players },
      hit: (id) => {
        hits.push(id);
      },
    });
    hazards.advance(1_800_000);
    const meteor = hazards.snapshot()[0];
    if (!meteor) {
      throw new Error('Meteor missing');
    }
    inactive.position = { ...meteor.position };
    bot.position = { ...meteor.position };
    players.push(inactive, bot);
    hazards.advance(1_800_017);
    expect(hits).toEqual(['worker']);
    hazards.advance(1_800_034);
    expect(hazards.snapshot()).toEqual([]);
    expect(hits).toEqual(['worker']);
  }
);
