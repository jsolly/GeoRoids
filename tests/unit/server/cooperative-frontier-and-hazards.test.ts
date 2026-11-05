/* @vitest-environment node */
import { afterEach, expect, test } from 'vitest';
import { EntityManager } from '../../../server/core/EntityManager';
import { GameEngine } from '../../../server/core/GameEngine';
import { HiveEncounters } from '../../../server/core/HiveEncounters';
import { RNGService } from '../../../server/core/RNGService';
import { TerrainSpiderManager } from '../../../server/core/TerrainSpiderManager';
import { WorldHazards } from '../../../server/core/WorldHazards';
import { CooperativeCampaign } from '../../../server/world/CooperativeCampaign';
import { COOPERATIVE } from '../../../shared/cooperativeRules';
import { frontierSite, frontierSitesNear, sacPosition } from '../../../shared/frontier';
import { hazardPhase } from '../../../shared/worldHazards';
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
  const pilot = engine.addPlayer(
    'hauler',
    'Hauler',
    new RecordingSocket(),
    site.position,
    'hauler'
  );
  pilot.position = { x: site.position.x + 150, y: site.position.y };
  pilot.haulerUtility = 'tow_cable';
  const campaign = new CooperativeCampaign({ schemaVersion: 1, activated: true, records: [] });
  const spiders = new TerrainSpiderManager(() => 0.5);
  const hives = new HiveEncounters(campaign, spiders);
  hives.refresh([pilot]);
  return { engine, site, pilot, campaign, spiders, hives };
}

test('shield blocks a lone gun; a solo tow exposes 500 HP and death permanently removes owned births', () => {
  const { site, pilot, campaign, spiders, hives } = scene();
  expect(hives.hit(site.id, pilot, 500, 1000)).toBe(false);
  for (let i = 0; i < COOPERATIVE.birthFrames * 7; i++) {
    hives.advance([pilot], 1000 + i);
  }
  expect(spiders.snapshot().spiders).toHaveLength(6);
  pilot.harpoonTargetId = site.id;
  hives.advance([pilot], 5000);
  expect(hives.hit(site.id, pilot, 499, 5000)).toBe(true);
  expect(campaign.get('hive', site.id)?.queenHealth).toBe(1);
  expect(hives.hit(site.id, pilot, 1, 5001)).toBe(true);
  expect(spiders.snapshot().spiders).toHaveLength(0);
  hives.refresh([]);
  hives.refresh([pilot]);
  const restarted = new HiveEncounters(
    new CooperativeCampaign({
      schemaVersion: 1,
      activated: true,
      records: structuredClone([...campaign.all()]),
    }),
    spiders
  );
  restarted.refresh([pilot]);
  for (let i = 0; i < 600; i++) {
    restarted.advance([pilot], 10_000 + i);
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
  const { site, pilot, hives, campaign } = scene();
  const a = sacPosition(site.position, 0, 2),
    b = sacPosition(site.position, 1, 2);
  expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeCloseTo(450);
  hives.hit(`${site.id}/sac/0`, pilot, 50, 1000);
  hives.advance([pilot], 20_999);
  expect(campaign.get('hive', site.id)?.sacs).toEqual([0, 50]);
  hives.advance([pilot], 21_000);
  expect(campaign.get('hive', site.id)?.sacs).toEqual([50, 50]);
  hives.hit(`${site.id}/sac/0`, pilot, 50, 22_000);
  hives.hit(`${site.id}/sac/1`, pilot, 50, 41_999);
  hives.refresh([]);
  hives.refresh([pilot]);
  hives.advance([pilot], 80_000);
  expect(campaign.get('hive', site.id)?.sacs).toEqual([0, 0]);
  const expanded = frontierSitesNear({ x: 22500, y: 2500 }, 1000)[0];
  if (!expanded) {
    throw new Error('Expanded fixture');
  }
  pilot.position = expanded.position;
  hives.refresh([pilot]);
  expect(hives.snapshot(80_000)).toEqual([]);
  campaign.set({
    kind: 'project',
    id: 'deep-scanner',
    deliveredValue: 10_000,
    completedAt: 80_000,
  });
  hives.refresh([pilot]);
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
  const { pilot, spiders } = scene();
  spiders.setPopulationLimit(36, 48);
  for (let i = 0; i < 40; i++) {
    spiders.spawnSpider({ x: 5000 + i, y: 5000 });
  }
  expect(spiders.snapshot().spiders).toHaveLength(36);
  const ordinary = spiders.snapshot().spiders.map((s) => s.id);
  const hazards = new WorldHazards(spiders);
  for (let i = 0; i < 20; i++) {
    hazards.advance(i * 1000, [pilot], () => {
      throw new Error('Swarm damage belongs to combat');
    });
  }
  expect(hazards.swarmCount()).toBe(12);
  expect(spiders.snapshot().spiders).toHaveLength(48);
  hazards.advance(180_000, [pilot], () => {});
  expect(spiders.snapshot().spiders.map((s) => s.id)).toEqual(ordinary);
  hazards.advance(3_600_000, [], () => {});
  expect(hazards.swarmCount()).toBe(0);
  hazards.advance(3_700_000, [pilot], () => {});
  expect(hazards.swarmCount()).toBe(1);
  hazards.advance(3_500_000, [pilot], () => {});
  expect(hazards.swarmCount()).toBe(0);
});

test('meteors use normal cargo shielding and expire without changing structures', () => {
  const { engine, pilot, spiders } = scene();
  pilot.spawnProtectionTimer = 0;
  pilot.cargo = 300;
  const before = structuredClone(engine.getGameState().civicModules);
  const health = pilot.health;
  const hazards = new WorldHazards(spiders);
  const damage = (id: string) => {
    engine.handleShipDamage(id, 'asteroid', 50);
  };
  hazards.advance(1_800_000, [pilot], damage);
  const meteor = hazards.snapshot()[0];
  if (!meteor) {
    throw new Error('Meteor missing');
  }
  pilot.position = { ...meteor.position };
  hazards.advance(1_800_017, [pilot], damage);
  expect(pilot.cargo).toBe(0);
  expect(pilot.health).toBe(health - 20);
  hazards.advance(1_980_000, [pilot], damage);
  expect(hazards.snapshot()).toEqual([]);
  expect(engine.getGameState().civicModules).toEqual(before);
});

test('new belt occupants shrink ordinary capacity without stealing the twelve swarm slots', () => {
  const { pilot, spiders } = scene();
  spiders.setPopulationLimit(36, 48);
  for (let i = 0; i < 36; i++) {
    spiders.spawnSpider({ x: 5000 + i, y: 5000 });
  }
  const hazards = new WorldHazards(spiders);
  for (let i = 0; i < 12; i++) {
    hazards.advance(i * 1000, [pilot], () => {});
  }
  spiders.setPopulationLimit(24, 36);
  expect(spiders.snapshot().spiders).toHaveLength(36);
  expect(hazards.swarmCount()).toBe(12);
  hazards.advance(12_000, [pilot], () => {});
  expect(hazards.swarmCount()).toBe(12);
  hazards.advance(180_000, [pilot], () => {});
  expect(spiders.snapshot().spiders).toHaveLength(24);
});

test.each(['downed', 'exploding', 'disconnected', 'transit'] as const)(
  'meteors pass through %s hulls and hit a live bot behind them',
  (state) => {
    const { engine, pilot, spiders } = scene();
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
    const hazards = new WorldHazards(spiders);
    const hits: string[] = [];
    hazards.advance(1_800_000, [pilot], (id) => hits.push(id));
    const meteor = hazards.snapshot()[0];
    if (!meteor) {
      throw new Error('Meteor missing');
    }
    inactive.position = { ...meteor.position };
    bot.position = { ...meteor.position };
    hazards.advance(1_800_017, [pilot, inactive, bot], (id) => hits.push(id));
    expect(hits).toEqual(['worker']);
    hazards.advance(1_800_034, [pilot, inactive, bot], (id) => hits.push(id));
    expect(hazards.snapshot()).toEqual([]);
    expect(hits).toEqual(['worker']);
  }
);
