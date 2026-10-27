/* @vitest-environment node */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test } from 'vitest';
import { BeltCrawlerManager } from '../../../server/core/BeltCrawlerManager';
import { GameEngine } from '../../../server/core/GameEngine';
import { ServerClock } from '../../../server/core/ServerClock';
import { TerrainSpiderManager } from '../../../server/core/TerrainSpiderManager';
import { WorldHazards } from '../../../server/core/WorldHazards';
import { AsteroidSpatialIndex } from '../../../server/world/AsteroidSpatialIndex';
import {
  legacyWorldDigest,
  migrateCooperativeWorld,
} from '../../../server/world/cooperativeSchema';
import { InlineWorldPersistence } from '../../../server/world/InlineWorldPersistence';
import { WorldStore } from '../../../server/world/WorldStore';
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

test('the real activated engine reserves twelve swarm slots before admitting crowded belt bodies', () => {
  const dir = mkdtempSync(join(tmpdir(), 'campaign-budget-'));
  const path = join(dir, 'world.sqlite');
  new WorldStore(path).close();
  const db = new DatabaseSync(path);
  migrateCooperativeWorld(db, legacyWorldDigest(db));
  db.exec('UPDATE cooperative_schema SET activated=1');
  db.close();
  const store = new WorldStore(path);
  let elapsed = 0;
  const clock = new ServerClock({ wallNow: () => 0, monotonicNow: () => elapsed });
  const engine = new GameEngine(82, clock, new InlineWorldPersistence(store));
  try {
    const pilot = engine.addPlayer('pilot', 'Pilot', new RecordingSocket(), { x: 5000, y: 5000 });
    pilot.position = { x: 5000, y: 5000 };
    for (const rock of hosts()) {
      engine.addAsteroid(rock);
    }
    // Hazards run before ordinary spawners; each frame admits at most one event actor.
    for (let second = 0; second < 12; second++) {
      elapsed = second * 1000;
      engine.advanceOneFrame();
    }
    const spiders = engine.getGameState().spiderField?.spiders ?? [];
    expect(spiders.filter((spider) => spider.crawler).length).toBeGreaterThan(0);
    expect(spiders.filter((spider) => spider.crawler).length).toBeLessThanOrEqual(36);
    expect(spiders).toHaveLength(48);
  } finally {
    engine.stopGameLoop();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
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
      const hazards = new WorldHazards(spiders);
      for (let second = 0; second < 12; second++) {
        hazards.advance(second * 1000, [pilot], () => {});
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
      hazards.advance(180_000, [pilot], () => {});
      for (let second = 0; second < 12; second++) {
        hazards.advance(3_600_000 + second * 1000, [pilot], () => {});
      }
      expect(hazards.swarmCount()).toBe(12);
      expect(spiders.snapshot().spiders).toHaveLength(48);
    } finally {
      engine.stopGameLoop();
    }
  }
);
