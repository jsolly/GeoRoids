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
  civicModuleName,
  furnaceReward,
  TOWN_HEARTH,
  TOWN_SPAWN_RADIUS,
  validCivicModules,
} from '../../../shared/furnaces';
import { validateSnapshotDto } from '../../../shared/snapshotDto';
import { SPIDER } from '../../../shared/terrainSpider';
import { WORLD } from '../../../shared/world';
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

function addScout(engine: GameEngine, id = 'scout', socket = new RecordingSocket()) {
  const actor = engine.addPlayer(id, id, socket, { ...street.position }, 'scout');
  actor.position = { ...street.position };
  actor.asteroidInteractions = 1;
  const pilot = engine.registerPilot(actor, socket);
  assert(pilot.ok);
  actor.abilityCooldownFrames = 0;
  return { actor, socket, token: pilot.resumeToken };
}

function clearRocks(engine: GameEngine): void {
  for (const rock of engine.getAllAsteroids()) {
    engine.removeAsteroid(rock.id);
  }
}

test('a fresh flight stands on the town ring even when another pilot is far away', () => {
  const engine = new GameEngine(42);
  engine.addPlayer('far', 'Far', new RecordingSocket(), { x: 20_000, y: 12_000 }, 'hauler');
  const fresh = engine.addPlayer('new', 'New', new RecordingSocket());
  expect(Math.hypot(fresh.position.x, fresh.position.y)).toBeCloseTo(TOWN_SPAWN_RADIUS, 5);
});

test('a furnace delivery pays each contributor and does not bank a shared purse', () => {
  const engine = new GameEngine(42);
  const hauler = engine.addPlayer(
    'hauler',
    'Hauler',
    new RecordingSocket(),
    { x: 0, y: 0 },
    'hauler'
  );
  const scout = addScout(engine);
  clearRocks(engine);
  const rock = cargo('shared', { x: 0, y: 0 });
  rock.boost = { phase: 'burning', ownerId: hauler.id, angle: 0 };
  rock.surveyedBy = [scout.actor.id, 'offline'];
  engine.addAsteroid(rock);
  engine.processFurnaceDeliveries();
  const reward = furnaceReward(rock);
  expect(hauler.score).toBe(reward);
  expect(scout.actor.score).toBe(reward);
  expect(engine.getGameState().civicModules).toEqual([]);
  expect(engine.getGameState()).not.toHaveProperty('townCredit');
  engine.processFurnaceDeliveries();
  expect(engine.drainFurnaceDeliveries()).toHaveLength(1);
  expect(hauler.score).toBe(reward);
});

test('a Scout builds only the street foundation they are standing in and pays with their own score', () => {
  const engine = new GameEngine(42);
  const scout = addScout(engine);
  const bystander = engine.addPlayer(
    'rich',
    'Rich',
    new RecordingSocket(),
    { x: 10, y: 10 },
    'hauler'
  );
  bystander.score = street.cost * 2;
  expect(engine.useAbility(scout.actor.id)).toBe(false);
  expect(engine.furnaceBuildIssue(scout.actor.id)).toBe(`You need ${street.cost} more score`);
  expect(scout.actor.score).toBe(0);
  expect(scout.actor.abilityCooldownFrames).toBe(0);
  scout.actor.score = street.cost;
  // Inside approach range of a dark lot, but outside the grate — Build is offered and refuses.
  scout.actor.position = {
    x: street.position.x + FURNACE_BUILD.RADIUS + 40,
    y: street.position.y,
  };
  expect(engine.useAbility(scout.actor.id)).toBe(false);
  expect(engine.furnaceBuildIssue(scout.actor.id)).toBe(FURNACE_BUILD.ISSUE.STAND);
  expect(scout.actor.score).toBe(street.cost);
  scout.actor.position = { ...child.position };
  expect(engine.furnaceBuildIssue(scout.actor.id)).toBe(`Light ${street.name} first`);
  scout.actor.position = { ...street.position };
  expect(engine.useAbility(scout.actor.id)).toBe(true);
  const builtName = civicModuleName('scout', street.name);
  expect(engine.furnaceBuildNotice()).toBe(`${builtName} is burning`);
  expect(scout.actor.score).toBe(0);
  expect(bystander.score).toBe(street.cost * 2);
  expect(engine.getGameState().civicModules).toEqual([
    { id: street.id, builderName: 'scout', builderId: 'scout' },
  ]);
  expect(engine.getGameState().mapAssets).toContainEqual({
    id: `furnace:${street.id}`,
    name: builtName,
    kind: 'furnace',
    position: street.position,
  });
  expect(scout.actor.abilityCooldownFrames).toBe(0);
  scout.actor.abilityCooldownFrames = 0;
  // Lit lot: E returns to Mineral Scan; Build is no longer offered here.
  expect(engine.furnaceBuildIssue(scout.actor.id)).toBe(FURNACE_BUILD.ISSUE.LIT);
  expect(engine.useAbility(scout.actor.id)).toBe(true);
  expect(scout.actor.abilityActiveFrames).toBeGreaterThan(0);
  expect(scout.actor.score).toBe(0);
  validateSnapshotDto({ ...engine.getGameState(), collabTags: [], playerProjectiles: [] });
});

test('a dead ship and the wrong kit spend neither score nor a street', () => {
  const engine = new GameEngine(42);
  const { actor } = addScout(engine);
  actor.score = street.cost;
  actor.health = 0;
  expect(engine.useAbility(actor.id)).toBe(false);
  expect(engine.furnaceBuildIssue(actor.id)).toBe(FURNACE_BUILD.ISSUE.READY);
  actor.health = 100;
  expect(engine.useAbility(actor.id, 'hauler')).toBe(false);
  expect(engine.getGameState().civicModules).toEqual([]);
  expect(actor.score).toBe(street.cost);
  const hauler = engine.addPlayer('hauler', 'Hauler', new RecordingSocket(), undefined, 'hauler');
  expect(engine.setScoutUtility(hauler.id, 'mineral_scan')).toBe(false);
});

test('a named street and the builder leftover score survive a SQLite restart', () => {
  const directory = mkdtempSync(join(tmpdir(), 'town-raise-'));
  const path = join(directory, 'world.sqlite');
  const firstStore = new WorldStore(path);
  try {
    const engine = new GameEngine(42, undefined, new InlineWorldPersistence(firstStore));
    const { actor, token } = addScout(engine);
    const leftover = 40;
    actor.score = street.cost + leftover;
    expect(engine.useAbility(actor.id)).toBe(true);
    const lit = engine.getGameState().civicModules;
    expect(actor.score).toBe(leftover);
    expect(lit).toEqual([{ id: street.id, builderName: 'scout', builderId: 'scout' }]);
    engine.removePlayer(actor.id);
    expect(firstStore.loadWorld()?.civicModules).toEqual(lit);
    firstStore.close();
    const written = new DatabaseSync(path);
    const row = written.prepare('SELECT json FROM world WHERE id=1').get() as { json: string };
    expect(JSON.parse(row.json)).not.toHaveProperty('townCredit');
    written.close();
    const secondStore = new WorldStore(path);
    try {
      const restarted = new GameEngine(99, undefined, new InlineWorldPersistence(secondStore));
      const resumed = restarted.resumePilot(token, new RecordingSocket(), 'scout', 'New name');
      assert(resumed.ok);
      expect(resumed.actor.score).toBe(leftover);
      expect(restarted.getGameState().civicModules).toEqual(lit);
      expect(restarted.getGameState().mapAssets).toContainEqual(
        expect.objectContaining({
          id: `furnace:${street.id}`,
          name: civicModuleName('scout', street.name),
        })
      );
      resumed.actor.position = { ...street.position };
      resumed.actor.abilityCooldownFrames = 0;
      expect(restarted.furnaceBuildIssue(resumed.actor.id)).toBe(FURNACE_BUILD.ISSUE.LIT);
      expect(restarted.useAbility(resumed.actor.id)).toBe(true);
      expect(resumed.actor.score).toBe(leftover);
    } finally {
      secondStore.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('an obsolete personal-furnace save does not restore hearths, and a broken module list fails startup', () => {
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
        exploration: [],
      },
      new Map(),
      []
    );
    store.close();
    const db = new DatabaseSync(path);
    const row = db.prepare('SELECT json FROM world WHERE id=1').get() as { json: string };
    const saved = JSON.parse(row.json) as {
      builtFurnaces?: unknown;
      townCredit?: number;
      civicModules?: unknown;
      litCivicLotIds?: string[];
    };
    saved.builtFurnaces = [
      {
        id: 'built:pilot:1',
        ownerId: 'pilot',
        name: 'Yard',
        radius: 85,
        position: { x: 2200, y: 2200 },
      },
    ];
    saved.townCredit = -1;
    db.prepare('UPDATE world SET json=? WHERE id=1').run(JSON.stringify(saved));
    db.close();
    const loaded = new WorldStore(path);
    try {
      expect(loaded.loadWorld()?.civicModules).toEqual([]);
      const engine = new GameEngine(42, undefined, new InlineWorldPersistence(loaded));
      expect(engine.getGameState().civicModules).toEqual([]);
      expect(engine.furnaceBuildNotice()).toBe('');
      engine.checkpointWorld();
      const rewrittenDb = new DatabaseSync(path);
      const rewritten = rewrittenDb.prepare('SELECT json FROM world WHERE id=1').get() as {
        json: string;
      };
      rewrittenDb.close();
      const next = JSON.parse(rewritten.json) as { townCredit?: unknown; civicModules?: unknown };
      expect(next).not.toHaveProperty('townCredit');
      expect(next.civicModules).toEqual([]);
    } finally {
      loaded.close();
    }
    const namedOnlyById = new DatabaseSync(path);
    delete saved.civicModules;
    saved.litCivicLotIds = [street.id];
    namedOnlyById.prepare('UPDATE world SET json=? WHERE id=1').run(JSON.stringify(saved));
    namedOnlyById.close();
    const migrated = new WorldStore(path);
    expect(migrated.loadWorld()?.civicModules).toEqual([{ id: street.id, builderName: '' }]);
    migrated.close();
    const childOnly = new DatabaseSync(path);
    saved.civicModules = [{ id: child.id, builderName: 'Ada' }];
    delete saved.litCivicLotIds;
    childOnly.prepare('UPDATE world SET json=? WHERE id=1').run(JSON.stringify(saved));
    childOnly.close();
    const orphan = new WorldStore(path);
    expect(() => orphan.loadWorld()).toThrow(/street furnaces/iu);
    orphan.close();
    const rudeName = new DatabaseSync(path);
    saved.civicModules = [{ id: street.id, builderName: 'Ada!' }];
    rudeName.prepare('UPDATE world SET json=? WHERE id=1').run(JSON.stringify(saved));
    rudeName.close();
    const rejected = new WorldStore(path);
    expect(() => rejected.loadWorld()).toThrow(/street furnaces/iu);
    rejected.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('boost guidance prefers a lit street over the square, and dark lots are not hearths', () => {
  const field = new FurnaceField();
  expect(field.litModules()).toEqual([]);
  expect(validCivicModules(field.litModules())).toBe(true);
  field.light(street.id, 'Ada');
  const first = field.litModules();
  field.replaceLit(first.map((module) => ({ ...module })));
  expect(field.litModules()).toBe(first);
  expect(field.displayName(street.id)).toBe(civicModuleName('Ada', street.name));
  expect(field.nearby(street.position, 1).find((site) => site.id === street.id)?.name).toBe(
    civicModuleName('Ada', street.name)
  );
  const rock = cargo('guided', { x: street.position.x + 100, y: street.position.y });
  rock.boost = { phase: 'burning', ownerId: 'pilot', angle: 0 };
  expect(Math.abs(furnaceHeading(rock.position, field))).toBeCloseTo(Math.PI);
  tickAsteroidBoost(rock, field);
  expect(rock.velocity.x).toBeLessThan(0);
  expect(new FurnaceField().nearby(street.position, street.radius)).toEqual([]);
  expect(field.nearby(street.position, 1).some((site) => site.id === street.id)).toBe(true);
});

test('raising a street during a chase repels the living spider despite tool cooldown', () => {
  const engine = new GameEngine(42);
  const { actor } = addScout(engine);
  actor.score = street.cost;
  const spider = engine.spawnTerrainSpider({
    x: street.position.x + 200,
    y: street.position.y,
  });
  assert(spider);
  engine.advanceOneFrame();
  expect(engine.getSpiderField().spiders.find((body) => body.id === spider.id)?.targetId).toBe(
    actor.id
  );
  actor.abilityCooldownFrames = 300;
  const health = actor.health;
  expect(engine.useAbility(actor.id)).toBe(true);
  expect(actor.abilityCooldownFrames).toBe(300);
  expect(
    engine.getSpiderField().spiders.find((body) => body.id === spider.id)?.targetId
  ).toBeNull();
  engine.advanceOneFrame();
  const escaped = engine.getSpiderField().spiders.find((body) => body.id === spider.id);
  expect(escaped?.health).toBe(spider.health);
  expect(escaped?.position.x).toBeGreaterThan(spider.position.x);
  expect(actor.health).toBe(health);
});

test('a raised street toasts the Scout with the lot name', () => {
  const engine = new GameEngine(42);
  const socket = new RecordingSocket();
  const scout = addScout(engine, 'scout', socket);
  scout.actor.score = street.cost;
  const broadcaster = new GameStateBroadcaster(engine);
  const handler = new MessageHandler(engine, broadcaster);
  handler.handleMessage({ type: 'useAbility', id: scout.actor.id, kitId: 'scout' }, socket);
  expect(socket.lastReceived('furnaceBuildResult')?.data).toBe(
    `${civicModuleName('scout', street.name)} is burning`
  );
  expect(engine.getGameState().civicModules).toEqual([
    { id: street.id, builderName: 'scout', builderId: 'scout' },
  ]);
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
    const retreating = manager.snapshot().spiders.find((body) => body.id === inside.id);
    expect(retreating?.health).toBe(inside.health);
    expect(retreating?.position.x).toBeGreaterThan(inside.position.x);
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

test('a Scout can light a nest-covered foundation and all its guards flee alive', () => {
  const engine = new GameEngine(42);
  const { actor } = addScout(engine);
  engine.prepareDiagnosticWorld('traversal');
  clearRocks(engine);
  engine.parkSatellitePickups();
  actor.position = { x: street.position.x + 2000, y: street.position.y };
  engine.addAsteroid(cargo('nest-ore', street.position));
  engine.advanceCombatFrame();
  const guards = engine.getSpiderField().spiders;
  expect(guards).toHaveLength(10);
  expect(engine.getSpiderField().nests).toHaveLength(1);
  actor.position = { ...street.position };
  actor.score = street.cost;
  actor.abilityCooldownFrames = 300;
  engine.advanceCombatFrame();
  const health = actor.health;
  expect(engine.furnaceBuildIssue(actor.id)).toBeUndefined();
  expect(engine.useAbility(actor.id)).toBe(true);
  const repelled = engine.getSpiderField().spiders;
  expect(repelled.map(({ id }) => id)).toEqual(guards.map(({ id }) => id));
  expect(repelled.every(({ targetId }) => targetId === null)).toBe(true);
  for (let frame = 0; frame < 60; frame++) {
    engine.advanceCombatFrame();
  }
  const fled = engine.getSpiderField().spiders;
  expect(fled).toHaveLength(10);
  expect(actor.health).toBeGreaterThanOrEqual(health);
  for (const before of guards) {
    const after = fled.find(({ id }) => id === before.id);
    assert(after);
    expect(after.health).toBe(before.health);
    expect(
      Math.hypot(after.position.x - street.position.x, after.position.y - street.position.y)
    ).toBeGreaterThan(
      Math.hypot(before.position.x - street.position.x, before.position.y - street.position.y)
    );
  }
});
