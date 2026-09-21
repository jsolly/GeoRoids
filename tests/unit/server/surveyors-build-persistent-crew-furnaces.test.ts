/* @vitest-environment node */
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { MessageHandler } from '../../../server/communication/MessageHandler';
import { GameEngine } from '../../../server/core/GameEngine';
import { TerrainSpiderManager } from '../../../server/core/TerrainSpiderManager';
import { GameStateBroadcaster } from '../../../server/services/GameStateBroadcaster';
import { InlineWorldPersistence } from '../../../server/world/InlineWorldPersistence';
import { WorldStore } from '../../../server/world/WorldStore';
import { furnaceHeading, tickAsteroidBoost } from '../../../shared/asteroidBoost';
import {
  FURNACE_BUILD,
  FurnaceField,
  furnacePlacementOrder,
  validBuiltFurnaces,
} from '../../../shared/furnaceField';
import { FURNACES } from '../../../shared/furnaces';
import { validateSnapshotDto } from '../../../shared/snapshotDto';
import { utcScoreSeason, WORLD } from '../../../shared/world';
import type { AsteroidData } from '../../../shared-types';
import { RecordingSocket } from '../../support/recordingSocket';

function builder(engine: GameEngine, id = 'scout', socket = new RecordingSocket()) {
  const actor = engine.addPlayer(id, id, socket, { x: 2200, y: 2200 }, 'surveyor');
  actor.position = { x: 2200, y: 2200 };
  actor.asteroidInteractions = 1;
  const pilot = engine.registerPilot(actor, socket);
  assert(pilot.ok);
  engine.setSurveyorUtility(id, 'build_furnace');
  return { actor, socket, token: pilot.resumeToken };
}

function buildThree(engine: GameEngine) {
  const scout = builder(engine);
  for (let index = 0; index < 3; index++) {
    scout.actor.position = { x: 2200 + index * 600, y: 2200 };
    scout.actor.abilityCooldownFrames = 0;
    expect(engine.useAbility(scout.actor.id)).toBe(true);
  }
  return scout;
}

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

test('each Surveyor can keep three furnaces, and a fourth yields their oldest site', () => {
  const engine = new GameEngine(42);
  const scout = buildThree(engine);
  const first = engine.getGameState().builtFurnaces?.[0];
  const kept = engine.getGameState().builtFurnaces?.slice(1) ?? [];
  assert(first);
  scout.actor.abilityCooldownFrames = 0;
  expect(engine.useAbility(scout.actor.id)).toBe(false);
  expect(engine.furnaceBuildIssue(scout.actor.id)).toBe('Too close to another furnace');
  expect(scout.actor.abilityCooldownFrames).toBe(0);
  expect(engine.getGameState().builtFurnaces).toHaveLength(3);
  expect(engine.getGameState().builtFurnaces).toContainEqual(first);
  scout.actor.position.x += 600;
  expect(engine.useAbility(scout.actor.id)).toBe(true);
  expect(engine.furnaceBuildNotice()).toBe(FURNACE_BUILD.NOTICE.YIELDED);
  const sites = engine.getGameState().builtFurnaces ?? [];
  expect(sites).toHaveLength(3);
  expect(sites.some((site) => site.id === first.id)).toBe(false);
  expect(sites).toEqual(expect.arrayContaining(kept));
  expect(sites.every((site) => site.ownerId === scout.actor.id)).toBe(true);
  expect(validBuiltFurnaces(sites)).toBe(true);
  const other = builder(engine, 'other');
  other.actor.position = { x: 2200, y: 3200 };
  expect(engine.useAbility(other.actor.id)).toBe(true);
  expect(engine.getGameState().builtFurnaces).toHaveLength(4);
  expect(
    engine.getGameState().builtFurnaces?.filter((site) => site.ownerId === 'other')
  ).toHaveLength(1);
  expect(FURNACES.some((site) => site.id.startsWith('built:'))).toBe(false);
  validateSnapshotDto({ ...engine.getGameState(), collabTags: [], playerProjectiles: [] });
});

test('construction refuses overlap, cooldown, dead ships, wrong kits and world edges without spending a slot', () => {
  const engine = new GameEngine(42);
  const { actor } = builder(engine);
  actor.position = { x: 0, y: -660 };
  expect(engine.useAbility(actor.id)).toBe(false);
  actor.position = { x: WORLD.radius, y: 0 };
  expect(engine.useAbility(actor.id)).toBe(false);
  actor.position = { x: 2200, y: 2200 };
  actor.health = 0;
  expect(engine.useAbility(actor.id)).toBe(false);
  actor.health = 100;
  actor.abilityCooldownFrames = 1;
  expect(engine.useAbility(actor.id)).toBe(false);
  actor.abilityCooldownFrames = 0;
  expect(engine.useAbility(actor.id, 'hauler')).toBe(false);
  expect(engine.useAbility(actor.id)).toBe(true);
  actor.abilityCooldownFrames = 0;
  actor.position.x += FURNACE_BUILD.MIN_DISTANCE;
  expect(engine.useAbility(actor.id)).toBe(false);
  expect(engine.getGameState().builtFurnaces).toHaveLength(1);
  const hauler = engine.addPlayer('hauler', 'Hauler', new RecordingSocket(), undefined, 'hauler');
  expect(engine.setSurveyorUtility(hauler.id, 'build_furnace')).toBe(false);
});

test('furnaces and the owner cap survive the last disconnect and a SQLite restart with the same pilot credential', () => {
  const directory = mkdtempSync(join(tmpdir(), 'surveyor-build-'));
  const path = join(directory, 'world.sqlite');
  const firstStore = new WorldStore(path);
  try {
    const engine = new GameEngine(42, undefined, new InlineWorldPersistence(firstStore));
    const { actor, token } = buildThree(engine);
    const expected = structuredClone(engine.getGameState().builtFurnaces);
    engine.removePlayer(actor.id);
    expect(firstStore.loadWorld()?.builtFurnaces).toEqual(expected);
    firstStore.close();
    const secondStore = new WorldStore(path);
    try {
      const restarted = new GameEngine(99, undefined, new InlineWorldPersistence(secondStore));
      const resumed = restarted.resumePilot(token, new RecordingSocket(), 'surveyor', 'New name');
      assert(resumed.ok);
      expect(resumed.actor.id).toBe(actor.id);
      expect(restarted.getGameState().builtFurnaces).toEqual(expected);
      restarted.setSurveyorUtility(resumed.actor.id, 'build_furnace');
      resumed.actor.abilityCooldownFrames = 0;
      const last = expected?.[expected.length - 1];
      assert(last);
      resumed.actor.position = { ...last.position };
      expect(restarted.useAbility(resumed.actor.id)).toBe(false);
      expect(restarted.furnaceBuildIssue(resumed.actor.id)).toBe('Too close to another furnace');
      expect(restarted.getGameState().builtFurnaces).toEqual(expected);
      resumed.actor.position = { x: 2200, y: 3200 };
      expect(restarted.useAbility(resumed.actor.id)).toBe(true);
      const sites = restarted.getGameState().builtFurnaces ?? [];
      expect(sites).toHaveLength(3);
      expect(sites.some((site) => site.id === expected[0]?.id)).toBe(false);
      expect(sites).toEqual(expect.arrayContaining(expected.slice(1)));
      expect(validBuiltFurnaces(sites)).toBe(true);
    } finally {
      secondStore.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('built furnaces accept boosted and towed ore once and award ordinary delivery credit', () => {
  const engine = new GameEngine(42);
  const { actor } = builder(engine);
  expect(engine.useAbility(actor.id)).toBe(true);
  const hauler = engine.addPlayer('hauler', 'Hauler', new RecordingSocket(), undefined, 'hauler');
  hauler.position = { ...actor.position };
  for (const mode of ['tow', 'boost']) {
    const rock = cargo(mode, { ...actor.position });
    rock.surveyedBy = [actor.id];
    engine.addAsteroid(rock);
    if (mode === 'boost') {
      rock.boost = { phase: 'burning', ownerId: hauler.id, angle: 0 };
    } else {
      engine.setHaulerUtility(hauler.id, 'tow_cable');
      hauler.harpoonTargetId = rock.id;
    }
    engine.processFurnaceDeliveries();
    expect(engine.getAsteroid(rock.id)).toBeUndefined();
    expect(engine.drainFurnaceDeliveries()).toHaveLength(1);
    engine.processFurnaceDeliveries();
    expect(engine.drainFurnaceDeliveries()).toHaveLength(0);
  }
  expect(hauler.score).toBe(600);
  expect(actor.score).toBe(600);
});

test('boost guidance chooses a player-built furnace and separate worlds never share structures', () => {
  const field = new FurnaceField();
  field.add({
    id: 'built:pilot:1',
    ownerId: 'pilot',
    name: 'Works',
    radius: 85,
    position: { x: 2200, y: 2200 },
  });
  const rock = cargo('guided', { x: 2300, y: 2200 });
  rock.boost = { phase: 'burning', ownerId: 'pilot', angle: 0 };
  expect(Math.abs(furnaceHeading(rock.position, field))).toBeCloseTo(Math.PI);
  tickAsteroidBoost(rock, field);
  expect(rock.velocity.x).toBeLessThan(0);
  expect(rock.velocity.y).toBe(0);
  expect(new FurnaceField().snapshot()).toEqual([]);
  expect(validBuiltFurnaces(field.snapshot())).toBe(true);
  expect(validBuiltFurnaces([...field.snapshot(), ...field.snapshot()])).toBe(false);
  expect(validBuiltFurnaces([{ ...field.snapshot()[0], position: { x: Infinity, y: 0 } }])).toBe(
    false
  );
  expect(validBuiltFurnaces([{ ...field.snapshot()[0], placedAt: Number.NaN }])).toBe(false);
  expect(validBuiltFurnaces([{ ...field.snapshot()[0], placedAt: 12 }])).toBe(true);
  expect(
    validBuiltFurnaces([
      { ...field.snapshot()[0], id: 'built:pilot:1', ownerId: 'pilot' },
      { ...field.snapshot()[0], id: 'built:pilot:2', ownerId: 'pilot' },
      { ...field.snapshot()[0], id: 'built:pilot:3', ownerId: 'pilot' },
      { ...field.snapshot()[0], id: 'built:pilot:4', ownerId: 'pilot' },
    ])
  ).toBe(false);
});

test('construction leaves room inside the world edge for a full respawn ring', () => {
  const engine = new GameEngine(42);
  const { actor } = builder(engine);
  actor.position = { x: WORLD.radius - FURNACE_BUILD.RADIUS, y: 0 };
  expect(engine.useAbility(actor.id)).toBe(false);
  actor.position = { x: WORLD.radius - FURNACE_BUILD.WORLD_INSET, y: 0 };
  expect(engine.useAbility(actor.id)).toBe(true);
  actor.exploding = true;
  actor.health = 0;
  actor.respawnTimer = 1;
  engine.entityManager.updateRespawns();
  expect(Math.hypot(actor.position.x, actor.position.y)).toBeLessThan(WORLD.radius - 180);
});

test('unchanged snapshots retain the indexed furnace collection', () => {
  const field = new FurnaceField();
  const sites = [
    {
      id: 'built:pilot:1',
      ownerId: 'pilot',
      name: 'Works',
      radius: 85,
      position: { x: 2200, y: 2200 },
    },
  ];
  field.replace(sites);
  const first = field.snapshot();
  field.replace(structuredClone(sites));
  expect(field.snapshot()).toBe(first);
  expect(field.count('pilot')).toBe(1);
  expect(field.nearby(sites[0]?.position ?? { x: 0, y: 0 }, 1)).toHaveLength(1);
  field.replace([]);
  expect(field.count('pilot')).toBe(0);
  expect(field.nearby({ x: 2200, y: 2200 }, 1)).toEqual([]);
});

test('a furnace beside a cleared diagonal sector preserves its wall after restart', () => {
  const store = new WorldStore(':memory:');
  const now = Date.now();
  try {
    store.checkpoint(
      {
        seed: 42,
        startedAt: now,
        generation: WORLD.generation,
        scoreSeason: utcScoreSeason(now),
        exploration: [],
        completedSectors: ['1,1'],
      },
      new Map(),
      []
    );
    const engine = new GameEngine(42, undefined, new InlineWorldPersistence(store));
    const { actor } = builder(engine);
    actor.position = { x: 1935, y: 1935 };
    expect(engine.useAbility(actor.id)).toBe(true);
    engine.removePlayer(actor.id);
    const restarted = new GameEngine(42, undefined, new InlineWorldPersistence(store));
    expect(restarted.getCompletedSectors()).toContain('1,1');
    expect(restarted.getGameState().builtFurnaces).toHaveLength(1);
    const field = new FurnaceField();
    field.replace(restarted.getGameState().builtFurnaces ?? []);
    expect(field.hasSector('1,1')).toBe(false);
    expect(field.hasSector('1,0')).toBe(true);
    expect(field.hasSector('0,1')).toBe(true);
    field.replace([]);
    expect(field.hasSector('1,0')).toBe(false);
  } finally {
    store.close();
  }
});

test('building a furnace clears a spider already inside its new safe area', () => {
  const engine = new GameEngine(42);
  const { actor } = builder(engine);
  actor.position = { x: 3000, y: 5000 };
  const spider = engine.spawnTerrainSpider({ x: actor.position.x + 200, y: actor.position.y });
  assert(spider);
  expect(engine.getSpiderField().spiders.some((body) => body.id === spider.id)).toBe(true);
  expect(engine.useAbility(actor.id)).toBe(true);
  engine.advanceOneFrame();
  expect(engine.getSpiderField().spiders.some((body) => body.id === spider.id)).toBe(false);
});

test('a yielded furnace toasts the placing Surveyor over the ability result', () => {
  const engine = new GameEngine(42);
  const socket = new RecordingSocket();
  const scout = builder(engine, 'scout', socket);
  for (let index = 0; index < 3; index++) {
    scout.actor.position = { x: 2200 + index * 600, y: 2200 };
    scout.actor.abilityCooldownFrames = 0;
    expect(engine.useAbility(scout.actor.id)).toBe(true);
  }
  const broadcaster = new GameStateBroadcaster(engine);
  const handler = new MessageHandler(engine, broadcaster);
  scout.actor.abilityCooldownFrames = 0;
  scout.actor.position.x += 600;
  handler.handleMessage({ type: 'useAbility', id: scout.actor.id, kitId: 'surveyor' }, socket);
  expect(socket.lastReceived('furnaceBuildResult')?.data).toBe(FURNACE_BUILD.NOTICE.YIELDED);
  expect(engine.getGameState().builtFurnaces).toHaveLength(3);
  broadcaster.stopPeriodicBroadcast();
});

test('legacy furnaces without placedAt still yield in serial order', () => {
  const field = new FurnaceField();
  const late = {
    id: 'built:pilot:2',
    ownerId: 'pilot',
    name: 'Later',
    radius: FURNACE_BUILD.RADIUS,
    position: { x: 2800, y: 2200 },
    placedAt: 50,
  };
  const early = {
    id: 'built:pilot:1',
    ownerId: 'pilot',
    name: 'Earlier',
    radius: FURNACE_BUILD.RADIUS,
    position: { x: 2200, y: 2200 },
  };
  field.replace([late, early]);
  expect(furnacePlacementOrder(early)).toBeLessThan(furnacePlacementOrder(late));
  expect(field.evictOldestOwned('pilot')?.id).toBe('built:pilot:1');
  expect(field.snapshot().map((site) => site.id)).toEqual(['built:pilot:2']);
  expect(field.evictOldestOwned('other')).toBeUndefined();
  expect(field.nearby(early.position, 1)).toEqual([]);
});

test('a player-built furnace matches a Works yard for spider occupancy and hunt break', () => {
  const works = FURNACES.find((site) => site.id === 'works-1-0');
  assert(works);
  const field = new FurnaceField();
  const builtAt = { x: 8000, y: 8000 };
  field.add({
    id: 'built:pilot:1',
    ownerId: 'pilot',
    name: 'Yard',
    radius: FURNACE_BUILD.RADIUS,
    position: builtAt,
  });
  const cases = [
    { manager: new TerrainSpiderManager(() => 0.5), origin: works.position },
    { manager: new TerrainSpiderManager(() => 0.5, field), origin: builtAt },
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
    manager.advance({ players: [witness], completedSectors: new Set(), nowFrame: 1 });
    expect(manager.snapshot().spiders.some((body) => body.id === inside.id)).toBe(false);

    const hunter = manager.spawnSpider({ x: origin.x + 500, y: origin.y });
    assert(hunter);
    const sheltered = {
      id: 'sheltered',
      position: { x: origin.x + 40, y: origin.y },
      health: 100,
      exploding: false,
    };
    manager.advance({ players: [sheltered], completedSectors: new Set(), nowFrame: 2 });
    expect(manager.snapshot().spiders.find((body) => body.id === hunter.id)?.targetId).toBeNull();
    expect(manager.snapshot().spiders.find((body) => body.id === hunter.id)?.phase).not.toBe(
      'hunting'
    );
  }
});
