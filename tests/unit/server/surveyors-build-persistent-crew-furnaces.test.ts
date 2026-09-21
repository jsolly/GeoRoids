/* @vitest-environment node */
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test } from 'vitest';
import { MessageHandler } from '../../../server/communication/MessageHandler';
import { GameEngine } from '../../../server/core/GameEngine';
import { TerrainSpiderManager } from '../../../server/core/TerrainSpiderManager';
import { GameStateBroadcaster } from '../../../server/services/GameStateBroadcaster';
import { InlineWorldPersistence } from '../../../server/world/InlineWorldPersistence';
import { WorldStore } from '../../../server/world/WorldStore';
import { furnaceHeading, tickAsteroidBoost } from '../../../shared/asteroidBoost';
import { FURNACE_BUILD, FurnaceField } from '../../../shared/furnaceField';
import {
  civicLot,
  furnaceReward,
  TOWN_HEARTH,
  TOWN_SPAWN_RADIUS,
  validLitCivicLotIds,
} from '../../../shared/furnaces';
import { validateSnapshotDto } from '../../../shared/snapshotDto';
import { SPIDER } from '../../../shared/terrainSpider';
import { utcScoreSeason, WORLD } from '../../../shared/world';
import type { AsteroidData } from '../../../shared-types';
import { RecordingSocket } from '../../support/recordingSocket';

const eastStreet = civicLot('street-1-0');
const secondRingStreet = civicLot('street-2-0');
if (!eastStreet || !secondRingStreet) {
  throw new Error('Missing street lots');
}
const street = eastStreet;
const child = secondRingStreet;

function cargo(id: string, position: { x: number; y: number }): AsteroidData {
  return {
    id,
    position,
    velocity: { x: 0, y: 0 },
    size: 25,
    material: 'metal',
    health: 75,
    maxHealth: 75,
    rotation: 0,
    angularVelocity: 0,
    jaggedness: 0.2,
    offsets: [1, 1, 1, 1],
    vertices: 4,
  };
}

function surveyor(engine: GameEngine, id = 'scout', socket = new RecordingSocket()) {
  const actor = engine.addPlayer(id, id, socket, { ...street.position }, 'surveyor');
  actor.position = { ...street.position };
  actor.asteroidInteractions = 1;
  const pilot = engine.registerPilot(actor, socket);
  assert(pilot.ok);
  engine.setSurveyorUtility(id, 'build_furnace');
  actor.abilityCooldownFrames = 0;
  return { actor, socket, token: pilot.resumeToken };
}

function clearRocks(engine: GameEngine): void {
  for (const rock of engine.getAllAsteroids()) {
    engine.removeAsteroid(rock.id);
  }
}

function bankMetal(engine: GameEngine, count: number): void {
  clearRocks(engine);
  for (let index = 0; index < count; index++) {
    const rock = cargo(`purse-${index}`, { x: 0, y: 0 });
    rock.boost = { phase: 'burning', ownerId: 'purse', angle: 0 };
    engine.addAsteroid(rock);
    engine.processFurnaceDeliveries();
    engine.drainFurnaceDeliveries();
  }
}

test('a fresh flight stands on the town ring even when another pilot is far away', () => {
  const engine = new GameEngine(42);
  engine.addPlayer('far', 'Far', new RecordingSocket(), { x: 20_000, y: 12_000 }, 'hauler');
  const fresh = engine.addPlayer('new', 'New', new RecordingSocket());
  expect(Math.hypot(fresh.position.x, fresh.position.y)).toBeCloseTo(TOWN_SPAWN_RADIUS, 5);
});

test('each furnace delivery banks the town purse once', () => {
  const engine = new GameEngine(42);
  const hauler = engine.addPlayer(
    'hauler',
    'Hauler',
    new RecordingSocket(),
    { x: 0, y: 0 },
    'hauler'
  );
  const scout = surveyor(engine);
  clearRocks(engine);
  const rock = cargo('shared', { x: 0, y: 0 });
  rock.boost = { phase: 'burning', ownerId: hauler.id, angle: 0 };
  rock.surveyedBy = [scout.actor.id, 'offline'];
  engine.addAsteroid(rock);
  engine.processFurnaceDeliveries();
  const reward = furnaceReward(rock);
  expect(engine.getGameState().townCredit).toBe(reward);
  expect(hauler.score).toBe(reward);
  expect(scout.actor.score).toBe(reward);
  engine.processFurnaceDeliveries();
  expect(engine.drainFurnaceDeliveries()).toHaveLength(1);
  expect(engine.getGameState().townCredit).toBe(reward);
});

test('a Surveyor raises only the street foundation they are standing in', () => {
  const engine = new GameEngine(42);
  const scout = surveyor(engine);
  expect(engine.useAbility(scout.actor.id)).toBe(false);
  expect(engine.furnaceBuildIssue(scout.actor.id)).toBe(`Town purse needs ${street.cost} more`);
  expect(engine.getGameState().townCredit).toBe(0);
  expect(scout.actor.abilityCooldownFrames).toBe(0);
  bankMetal(engine, street.cost / furnaceReward(cargo('rate', { x: 0, y: 0 })));
  scout.actor.position = { x: 2_200, y: 2_200 };
  expect(engine.useAbility(scout.actor.id)).toBe(false);
  expect(engine.furnaceBuildIssue(scout.actor.id)).toBe(FURNACE_BUILD.ISSUE.STAND);
  expect(engine.getGameState().townCredit).toBe(street.cost);
  scout.actor.position = { ...child.position };
  expect(engine.furnaceBuildIssue(scout.actor.id)).toBe(`Light ${street.name} first`);
  scout.actor.position = { ...street.position };
  expect(engine.useAbility(scout.actor.id)).toBe(true);
  expect(engine.furnaceBuildNotice()).toBe(`${street.name} is burning`);
  expect(engine.getGameState().townCredit).toBe(0);
  expect(engine.getGameState().litCivicLotIds).toEqual([street.id]);
  expect(scout.actor.abilityCooldownFrames).toBeGreaterThan(0);
  scout.actor.abilityCooldownFrames = 0;
  expect(engine.useAbility(scout.actor.id)).toBe(false);
  expect(engine.furnaceBuildIssue(scout.actor.id)).toBe(FURNACE_BUILD.ISSUE.LIT);
  expect(engine.getGameState().litCivicLotIds).toEqual([street.id]);
  validateSnapshotDto({ ...engine.getGameState(), collabTags: [], playerProjectiles: [] });
});

test('a dead ship, a cooldown, and the wrong kit spend neither purse nor a street', () => {
  const engine = new GameEngine(42);
  const { actor } = surveyor(engine);
  bankMetal(engine, 5);
  actor.health = 0;
  expect(engine.useAbility(actor.id)).toBe(false);
  expect(engine.furnaceBuildIssue(actor.id)).toBe(FURNACE_BUILD.ISSUE.READY);
  actor.health = 100;
  actor.abilityCooldownFrames = 1;
  expect(engine.useAbility(actor.id)).toBe(false);
  actor.abilityCooldownFrames = 0;
  expect(engine.useAbility(actor.id, 'hauler')).toBe(false);
  expect(engine.getGameState().litCivicLotIds).toEqual([]);
  expect(engine.getGameState().townCredit).toBe(street.cost);
  const hauler = engine.addPlayer('hauler', 'Hauler', new RecordingSocket(), undefined, 'hauler');
  expect(engine.setSurveyorUtility(hauler.id, 'build_furnace')).toBe(false);
});

test('a raised street and its leftover purse survive a SQLite restart', () => {
  const directory = mkdtempSync(join(tmpdir(), 'town-raise-'));
  const path = join(directory, 'world.sqlite');
  const firstStore = new WorldStore(path);
  try {
    const engine = new GameEngine(42, undefined, new InlineWorldPersistence(firstStore));
    const { actor, token } = surveyor(engine);
    bankMetal(engine, 6);
    expect(engine.useAbility(actor.id)).toBe(true);
    const purse = engine.getGameState().townCredit;
    const lit = engine.getGameState().litCivicLotIds;
    expect(purse).toBe(furnaceReward(cargo('rate', { x: 0, y: 0 })));
    expect(lit).toEqual([street.id]);
    engine.removePlayer(actor.id);
    expect(firstStore.loadWorld()?.townCredit).toBe(purse);
    expect(firstStore.loadWorld()?.litCivicLotIds).toEqual(lit);
    firstStore.close();
    const secondStore = new WorldStore(path);
    try {
      const restarted = new GameEngine(99, undefined, new InlineWorldPersistence(secondStore));
      const resumed = restarted.resumePilot(token, new RecordingSocket(), 'surveyor', 'New name');
      assert(resumed.ok);
      expect(restarted.getGameState().townCredit).toBe(purse);
      expect(restarted.getGameState().litCivicLotIds).toEqual(lit);
      restarted.setSurveyorUtility(resumed.actor.id, 'build_furnace');
      resumed.actor.position = { ...street.position };
      resumed.actor.abilityCooldownFrames = 0;
      expect(restarted.useAbility(resumed.actor.id)).toBe(false);
      expect(restarted.furnaceBuildIssue(resumed.actor.id)).toBe(FURNACE_BUILD.ISSUE.LIT);
    } finally {
      secondStore.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('an obsolete personal-furnace save does not restore hearths, and a broken purse fails startup', () => {
  const directory = mkdtempSync(join(tmpdir(), 'town-legacy-'));
  const path = join(directory, 'world.sqlite');
  const store = new WorldStore(path);
  try {
    const now = Date.now();
    store.checkpoint(
      {
        seed: 42,
        startedAt: now,
        generation: WORLD.generation,
        scoreSeason: utcScoreSeason(now),
        exploration: [],
        townCredit: 0,
        litCivicLotIds: [],
      },
      new Map(),
      []
    );
    store.close();
    const db = new DatabaseSync(path);
    const row = db.prepare('SELECT json FROM world WHERE id=1').get() as { json: string };
    const saved = JSON.parse(row.json) as { builtFurnaces?: unknown; townCredit?: number };
    saved.builtFurnaces = [
      {
        id: 'built:pilot:1',
        ownerId: 'pilot',
        name: 'Yard',
        radius: 85,
        position: { x: 2200, y: 2200 },
      },
    ];
    db.prepare('UPDATE world SET json=? WHERE id=1').run(JSON.stringify(saved));
    db.close();
    const loaded = new WorldStore(path);
    try {
      expect(loaded.loadWorld()?.litCivicLotIds).toEqual([]);
      expect(loaded.loadWorld()?.townCredit).toBe(0);
      const engine = new GameEngine(42, undefined, new InlineWorldPersistence(loaded));
      expect(engine.getGameState().litCivicLotIds).toEqual([]);
      expect(engine.furnaceBuildNotice()).toBe('');
    } finally {
      loaded.close();
    }
    const broken = new DatabaseSync(path);
    saved.townCredit = -1;
    broken.prepare('UPDATE world SET json=? WHERE id=1').run(JSON.stringify(saved));
    broken.close();
    const rejected = new WorldStore(path);
    expect(() => rejected.loadWorld()).toThrow(/town purse/iu);
    rejected.close();
    const childOnly = new DatabaseSync(path);
    saved.townCredit = 0;
    (saved as { litCivicLotIds?: string[] }).litCivicLotIds = [child.id];
    childOnly.prepare('UPDATE world SET json=? WHERE id=1').run(JSON.stringify(saved));
    childOnly.close();
    const orphan = new WorldStore(path);
    expect(() => orphan.loadWorld()).toThrow(/street furnaces/iu);
    orphan.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a full purse does not grow past a safe integer', () => {
  const directory = mkdtempSync(join(tmpdir(), 'town-purse-'));
  const path = join(directory, 'world.sqlite');
  const store = new WorldStore(path);
  try {
    const now = Date.now();
    store.checkpoint(
      {
        seed: 42,
        startedAt: now,
        generation: WORLD.generation,
        scoreSeason: utcScoreSeason(now),
        exploration: [],
        townCredit: Number.MAX_SAFE_INTEGER,
        litCivicLotIds: [],
      },
      new Map(),
      []
    );
    const engine = new GameEngine(42, undefined, new InlineWorldPersistence(store));
    engine.addAsteroid(cargo('overflow', { x: 0, y: 0 }));
    engine.processFurnaceDeliveries();
    expect(engine.getGameState().townCredit).toBe(Number.MAX_SAFE_INTEGER);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('boost guidance prefers a lit street over the square, and dark lots are not hearths', () => {
  const field = new FurnaceField();
  expect(field.litLotIds()).toEqual([]);
  expect(validLitCivicLotIds(field.litLotIds())).toBe(true);
  field.light(street.id);
  const first = field.litLotIds();
  field.replaceLit([...first]);
  expect(field.litLotIds()).toBe(first);
  const rock = cargo('guided', { x: street.position.x + 100, y: street.position.y });
  rock.boost = { phase: 'burning', ownerId: 'pilot', angle: 0 };
  expect(Math.abs(furnaceHeading(rock.position, field))).toBeCloseTo(Math.PI);
  tickAsteroidBoost(rock, field);
  expect(rock.velocity.x).toBeLessThan(0);
  expect(new FurnaceField().nearby(street.position, street.radius)).toEqual([]);
  expect(field.nearby(street.position, 1).some((site) => site.id === street.id)).toBe(true);
});

test('raising a street removes a spider already inside its safe radius', () => {
  const engine = new GameEngine(42);
  const { actor } = surveyor(engine);
  bankMetal(engine, 5);
  const spider = engine.spawnTerrainSpider({
    x: street.position.x + 200,
    y: street.position.y,
  });
  assert(spider);
  expect(engine.useAbility(actor.id)).toBe(true);
  engine.advanceOneFrame();
  expect(engine.getSpiderField().spiders.some((body) => body.id === spider.id)).toBe(false);
});

test('a raised street toasts the Surveyor with the lot name', () => {
  const engine = new GameEngine(42);
  const socket = new RecordingSocket();
  const scout = surveyor(engine, 'scout', socket);
  bankMetal(engine, 5);
  const broadcaster = new GameStateBroadcaster(engine);
  const handler = new MessageHandler(engine, broadcaster);
  handler.handleMessage({ type: 'useAbility', id: scout.actor.id, kitId: 'surveyor' }, socket);
  expect(socket.lastReceived('furnaceBuildResult')?.data).toBe(`${street.name} is burning`);
  expect(engine.getGameState().litCivicLotIds).toEqual([street.id]);
  broadcaster.stopPeriodicBroadcast();
});

test('a lit street matches Town Square for spider occupancy', () => {
  const field = new FurnaceField();
  field.light(street.id);
  const cases = [
    { manager: new TerrainSpiderManager(() => 0.5), origin: TOWN_HEARTH.position },
    { manager: new TerrainSpiderManager(() => 0.5, field), origin: street.position },
  ];
  for (const { manager, origin } of cases) {
    const inside = manager.spawnSpider({ x: origin.x + 80, y: origin.y });
    assert(inside);
    const witness = {
      id: 'witness',
      position: { x: origin.x + 2_000, y: origin.y },
      health: 100,
      exploding: false,
    };
    manager.advance({ players: [witness], nowFrame: 1 });
    expect(manager.snapshot().spiders.some((body) => body.id === inside.id)).toBe(false);
    const hunter = manager.spawnSpider({
      x:
        origin.x +
        Math.max(SPIDER.STARTER_SAFE_RADIUS, SPIDER.FURNACE_SAFE_RADIUS) +
        SPIDER.HIT_RADIUS +
        50,
      y: origin.y,
    });
    assert(hunter);
    const sheltered = {
      id: 'sheltered',
      position: { x: origin.x + 40, y: origin.y },
      health: 100,
      exploding: false,
    };
    manager.advance({ players: [sheltered], nowFrame: 2 });
    expect(manager.snapshot().spiders.find((body) => body.id === hunter.id)?.targetId).toBeNull();
  }
});
