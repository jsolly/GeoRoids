/* @vitest-environment node */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { expect, test } from 'vitest';
import { GameEngine } from '../../../server/core/GameEngine';
import { LootManager } from '../../../server/core/LootManager';
import { RNGService } from '../../../server/core/RNGService';
import { SatellitePickupManager } from '../../../server/core/SatellitePickupManager';
import { InlineWorldPersistence } from '../../../server/world/InlineWorldPersistence';
import { WorldStore } from '../../../server/world/WorldStore';
import { EQUIPMENT_DROPS, EQUIPMENT_IDS, isEquipmentId } from '../../../shared/equipment';
import { GROWTH } from '../../../shared/shipGrowth';
import { RecordingSocket } from '../../support/recordingSocket';
import { GameServerWorld, type Pilot } from '../scenarios/support/gameServerWorld';

/** Survey Probe is Scout-only, so a Hauler salvages just these. */
const HAULER_TOOLS = ['resource_tap', 'boost_coupling'];

test('fresh pilots can use their starter tool but cannot equip rare tools before collecting them', () => {
  const engine = new GameEngine(82);
  const hauler = engine.addPlayer('hauler', 'Hauler', new RecordingSocket(), undefined, 'hauler');
  const scout = engine.addPlayer('scout', 'Scout', new RecordingSocket(), undefined, 'scout');
  scout.position = { x: hauler.position.x + 1000, y: hauler.position.y };
  expect(hauler.equipment ?? []).toEqual([]);
  expect(scout.equipment ?? []).toEqual([]);
  expect(engine.setHaulerUtility(hauler.id, 'tow_cable')).toBe(true);
  expect(engine.setScoutUtility(scout.id, 'mineral_scan')).toBe(true);
  expect(engine.setHaulerUtility(hauler.id, 'resource_tap')).toBe(false);
  expect(engine.setHaulerUtility(hauler.id, 'boost_coupling')).toBe(false);
  expect(engine.setScoutUtility(scout.id, 'survey_probe')).toBe(false);
  for (const equipment of EQUIPMENT_IDS) {
    const actor = equipment === 'survey_probe' ? scout : hauler;
    const mass = actor.mass;
    const drop = engine.dropEquipmentAt(actor.position, equipment);
    expect(engine.collectLoot()).toContainEqual({ collectorId: actor.id, lootId: drop.id, mass });
    expect(actor.equipment).toContain(equipment);
    expect(actor.mass).toBe(mass);
  }
  expect(engine.setHaulerUtility(hauler.id, 'resource_tap')).toBe(true);
  expect(engine.setHaulerUtility(hauler.id, 'boost_coupling')).toBe(true);
  expect(engine.setScoutUtility(scout.id, 'survey_probe')).toBe(true);
  expect(engine.setHaulerUtility(hauler.id, 'survey_probe')).toBe(false);
  expect(engine.setScoutUtility(scout.id, 'resource_tap')).toBe(false);
});

test('a duplicate tool stays available for a different pilot', () => {
  const engine = new GameEngine(82);
  const alice = engine.addPlayer('alice', 'Alice', new RecordingSocket(), undefined, 'hauler');
  engine.dropEquipmentAt(alice.position, 'resource_tap');
  engine.collectLoot();
  const duplicate = engine.dropEquipmentAt(alice.position, 'resource_tap');
  expect(engine.collectLoot()).toEqual([]);
  expect(engine.getLoot()).toContainEqual(duplicate);
  const bob = engine.addPlayer('bob', 'Bob', new RecordingSocket(), undefined, 'hauler');
  bob.position = { ...alice.position };
  expect(engine.collectLoot()[0]?.collectorId).toBe(bob.id);
  expect(alice.equipment).toEqual(['resource_tap']);
  expect(bob.equipment).toEqual(['resource_tap']);
});

test('two identical tools collected in the same frame unlock once and leave both for others', () => {
  const engine = new GameEngine(82);
  const actor = engine.addPlayer('pilot', 'Pilot', new RecordingSocket(), undefined, 'hauler');
  engine.dropEquipmentAt(actor.position, 'resource_tap');
  engine.dropEquipmentAt(actor.position, 'resource_tap');
  expect(engine.collectLoot()).toHaveLength(1);
  expect(actor.equipment).toEqual(['resource_tap']);
  expect(engine.getLoot().filter((loot) => loot.kind === 'resource_tap')).toHaveLength(2);
});

test('each Hauler takes its own Boost Coupling from one drop while a Scout never sees it', () => {
  const world = new GameServerWorld();
  try {
    const maya = world.join('Maya Okafor', { x: 0, y: 0 }, { kitId: 'hauler' });
    const theo = world.join('Theo Lindqvist', { x: 0, y: 0 }, { kitId: 'hauler' });
    const rin = world.join('Rin Takahashi', { x: 0, y: 0 }, { kitId: 'scout' });
    const at = { ...world.entity(maya).position };
    world.entity(theo).position = { ...at };
    world.entity(rin).position = { ...at };
    const drop = world.engine.dropEquipmentAt(at, 'boost_coupling');
    world.broadcastGameState();
    const seen = (pilot: Pilot) => world.snapshot(pilot).loot.map((loot) => loot.id);
    expect(seen(maya)).toContain(drop.id);
    expect(seen(theo)).toContain(drop.id);
    expect(seen(rin)).not.toContain(drop.id);

    world.engine.collectLoot();
    world.engine.collectLoot();
    world.engine.collectLoot();
    expect(world.entity(maya).equipment).toEqual(['boost_coupling']);
    expect(world.entity(theo).equipment).toEqual(['boost_coupling']);
    expect(world.entity(rin).equipment ?? []).toEqual([]);
    world.broadcastGameState();
    expect(seen(maya)).not.toContain(drop.id);
    expect(seen(theo)).not.toContain(drop.id);
    // Pickup news stays private too: only each collector heard its own pickup.
    const pickups = (pilot: Pilot) =>
      pilot.socket.received('lootCollected').map((message) => message.data);
    expect(pickups(rin)).toEqual([]);
    expect(pickups(maya)).toEqual([expect.objectContaining({ collectorId: maya.id })]);
  } finally {
    world.dispose();
  }
});

test('salvaged tools survive an ordinary death, reconnect, and a server restart', () => {
  const store = new WorldStore(':memory:');
  try {
    const engine = new GameEngine(82, undefined, new InlineWorldPersistence(store));
    const socket = new RecordingSocket();
    const actor = engine.addPlayer('pilot', 'Pilot', socket, undefined, 'hauler');
    actor.asteroidInteractions = 1;
    const registered = engine.registerPilot(actor, socket);
    assert(registered.ok);
    for (const equipment of EQUIPMENT_IDS) {
      engine.dropEquipmentAt(actor.position, equipment);
    }
    engine.collectLoot();
    engine.collectLoot();
    expect(actor.equipment).toEqual(HAULER_TOOLS);
    actor.silk = 12;
    actor.color = '#FBBF24';
    actor.score = 400;
    actor.spawnProtectionTimer = 0;
    expect(engine.handleShipDamage(actor.id, 'asteroid', actor.health).isDestroyed).toBe(true);
    const continued = engine.resumePilot(registered.resumeToken, new RecordingSocket(), 'hauler');
    assert(continued.ok);
    expect(continued.actor.equipment).toEqual(HAULER_TOOLS);
    expect(continued.actor).toMatchObject({ silk: 12, score: 400, color: '#FBBF24' });
    expect(engine.setHaulerUtility(actor.id, 'boost_coupling')).toBe(true);
    engine.removePlayer(actor.id);
    const reconnected = engine.resumePilot(continued.resumeToken, new RecordingSocket(), 'scout');
    assert(reconnected.ok);
    expect(reconnected.actor.equipment).toEqual(HAULER_TOOLS);
    expect(engine.setScoutUtility(actor.id, 'survey_probe')).toBe(false);
    engine.checkpointWorld();
    const restarted = new GameEngine(0, undefined, new InlineWorldPersistence(store));
    const resumed = restarted.resumePilot(reconnected.resumeToken, new RecordingSocket(), 'hauler');
    assert(resumed.ok);
    expect(resumed.actor.equipment).toEqual(HAULER_TOOLS);
    expect(resumed.actor).toMatchObject({ silk: 12, score: 400, color: '#FBBF24' });
    expect(restarted.setHaulerUtility(actor.id, 'resource_tap')).toBe(true);
  } finally {
    store.close();
  }
});

test('saved pilots from before salvage unlocks return with no rare equipment', () => {
  const store = new WorldStore(':memory:');
  try {
    const token = 'a'.repeat(64);
    store.checkpoint(undefined, new Map(), [
      {
        id: 'legacy',
        name: 'Legacy',
        score: 10,
        tokenHash: createHash('sha256').update(token).digest('hex'),
      },
    ]);
    const engine = new GameEngine(82, undefined, new InlineWorldPersistence(store));
    const resumed = engine.resumePilot(token, new RecordingSocket(), 'hauler');
    assert(resumed.ok);
    expect(resumed.actor.equipment).toEqual([]);
    expect(engine.setHaulerUtility(resumed.actor.id, 'resource_tap')).toBe(false);
  } finally {
    store.close();
  }
});

test('guarded caches contain mixed salvage and occasionally one tool from every equipment type', () => {
  const cacheKinds = (seed: number) => {
    const manager = new LootManager(new RNGService(seed));
    manager.spawnNestCache({ x: 5000, y: 5000 }, 100);
    return manager.getAll().map((drop) => drop.kind);
  };
  const equipment = new Set<string>();
  let emptyCaches = 0;
  for (let seed = 0; seed < 100; seed++) {
    const kinds = cacheKinds(seed);
    expect(cacheKinds(seed)).toEqual(kinds);
    expect(kinds).toEqual(expect.arrayContaining(['shard', 'tap', 'silk']));
    const tools = kinds.filter(isEquipmentId);
    expect(tools.length).toBeLessThanOrEqual(1);
    if (tools.length === 0) {
      emptyCaches++;
    }
    for (const tool of tools) {
      equipment.add(tool);
    }
  }
  expect(equipment).toEqual(new Set(EQUIPMENT_IDS));
  expect(emptyCaches).toBeGreaterThan(15);
  expect(emptyCaches).toBeLessThan(55);
});

test('nest salvage remains for exploration but expires after its thirty-minute lifetime', () => {
  const manager = new LootManager(new RNGService(82));
  const createdAt = 100;
  manager.spawnNestCache({ x: 5000, y: 5000 }, createdAt);
  const count = manager.getCount();
  expect(count).toBeGreaterThanOrEqual(5);
  expect(manager.getAll().filter(({ kind }) => kind === 'shard')).toHaveLength(3);
  expect(manager.getAll().filter(({ kind }) => kind === 'tap')).toHaveLength(1);
  expect(manager.getAll().filter(({ kind }) => kind === 'silk')).toHaveLength(1);
  manager.expire(createdAt + GROWTH.LOOT_TTL_FRAMES);
  expect(manager.getCount()).toBe(count);
  manager.expire(createdAt + EQUIPMENT_DROPS.NEST_LIFETIME_FRAMES - 1);
  expect(manager.getCount()).toBe(count);
  manager.expire(createdAt + EQUIPMENT_DROPS.NEST_LIFETIME_FRAMES);
  expect(manager.getCount()).toBe(0);
});

test('nest rewards never seed further nests while ordinary salvage remains eligible', () => {
  const loot = new LootManager(new RNGService(82));
  const ordinaryShard = loot.spawnShard({ x: 5000, y: 5000 }, 0);
  loot.spawnNestCache({ x: 5000, y: 5000 }, 0);
  expect(loot.getAll().length).toBeGreaterThan(1);
  expect(loot.getNestResources()).toEqual([ordinaryShard]);
  loot.expire(1);
  expect(loot.getNestResources()).toEqual([ordinaryShard]);

  const satellites = new SatellitePickupManager(new RNGService(82));
  satellites.createPickups(1);
  const ordinarySatellites = satellites.getAllPickups();
  satellites.spawnNestPickup({ x: 5000, y: 5000 });
  expect(satellites.getAllPickups()).toHaveLength(ordinarySatellites.length + 1);
  expect(satellites.getNestResources()).toEqual(ordinarySatellites);
  for (const pickup of satellites.getAllPickups()) {
    expect(pickup).not.toHaveProperty('nestSalvage');
  }
  for (const drop of loot.getAll()) {
    expect(drop).not.toHaveProperty('nestCache');
  }
});

test('death preserves bank and equipment through a restart', () => {
  const store = new WorldStore(':memory:');
  try {
    const engine = new GameEngine(82, undefined, new InlineWorldPersistence(store));
    const socket = new RecordingSocket();
    const actor = engine.addPlayer('pilot', 'Pilot', socket, undefined, 'hauler');
    actor.asteroidInteractions = 1;
    const registered = engine.registerPilot(actor, socket);
    assert(registered.ok);
    for (const equipment of EQUIPMENT_IDS) {
      engine.dropEquipmentAt(actor.position, equipment);
    }
    engine.collectLoot();
    engine.collectLoot();
    actor.silk = 20;
    actor.score = 900;
    actor.color = '#FBBF24';
    expect(engine.setHaulerUtility(actor.id, 'resource_tap')).toBe(true);
    actor.spawnProtectionTimer = 0;
    engine.handleShipDamage(actor.id, 'asteroid', actor.health);
    expect(actor).toMatchObject({
      score: 900,
      silk: 20,
      equipment: HAULER_TOOLS,
      color: '#FBBF24',
      haulerUtility: 'resource_tap',
    });
    engine.checkpointWorld();
    expect(store.loadPilots()[0]).toMatchObject({
      score: 900,
      silk: 20,
      equipment: HAULER_TOOLS,
    });
    expect(store.loadPilots()[0]?.hullColor).toBe('#FBBF24');
    const restarted = new GameEngine(0, undefined, new InlineWorldPersistence(store));
    const resumed = restarted.resumePilot(registered.resumeToken, new RecordingSocket(), 'hauler');
    assert(resumed.ok);
    expect(resumed.actor).toMatchObject({
      score: 900,
      silk: 20,
      equipment: HAULER_TOOLS,
      color: '#FBBF24',
    });
    expect(restarted.setHaulerUtility(actor.id, 'resource_tap')).toBe(true);
  } finally {
    store.close();
  }
});

test('a dead saved flight retains bank, equipment, paint, and silk', () => {
  const store = new WorldStore(':memory:');
  try {
    const token = 'b'.repeat(64);
    store.checkpoint(undefined, new Map(), [
      {
        id: 'eliminated',
        name: 'Eliminated',
        lastSeenAt: Date.now(),
        kitId: 'scout',
        position: { x: 0, y: 0 },
        angle: 0,
        mass: 1,
        health: 0,
        score: 900,

        silk: 12,
        equipment: [...EQUIPMENT_IDS],
        hullColor: '#FBBF24',
        tokenHash: createHash('sha256').update(token).digest('hex'),
      },
    ]);
    const engine = new GameEngine(82, undefined, new InlineWorldPersistence(store));
    const resumed = engine.resumePilot(token, new RecordingSocket(), 'scout');
    assert(resumed.ok);
    expect(resumed.actor).toMatchObject({
      score: 900,
      silk: 12,
      equipment: [...EQUIPMENT_IDS],
      color: '#FBBF24',
    });
    expect(engine.setScoutUtility(resumed.actor.id, 'survey_probe')).toBe(true);
  } finally {
    store.close();
  }
});

test('a tool left behind for other pilots still expires with the nest lifetime', () => {
  const loot = new LootManager(new RNGService(82));
  const drop = loot.spawnEquipment({ x: 400, y: 300 }, 1_000, 'boost_coupling');
  loot.expire(1_000 + EQUIPMENT_DROPS.NEST_LIFETIME_FRAMES - 1);
  expect(loot.getAll().map((item) => item.id)).toContain(drop.id);
  loot.expire(1_000 + EQUIPMENT_DROPS.NEST_LIFETIME_FRAMES);
  expect(loot.getAll().map((item) => item.id)).not.toContain(drop.id);
});
