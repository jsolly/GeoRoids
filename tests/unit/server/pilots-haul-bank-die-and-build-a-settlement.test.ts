/* @vitest-environment node */

import { afterEach, expect, test, vi } from 'vitest';
import { MessageHandler } from '../../../server/communication/MessageHandler';
import { GameEngine } from '../../../server/core/GameEngine';
import { LootManager } from '../../../server/core/LootManager';
import { RNGService } from '../../../server/core/RNGService';
import { GameStateBroadcaster } from '../../../server/services/GameStateBroadcaster';
import {
  advanceSettlement,
  ECONOMY,
  emptySettlement,
  oreResource,
  oreYield,
} from '../../../shared/economy';
import { civicLot, TOWN_HEARTH } from '../../../shared/furnaces';
import type { AsteroidData } from '../../../shared-types';
import { SHIP } from '../../../src/constants';
import { hullRadiusForKit } from '../../../src/entities/ship/shipKits';
import { RecordingSocket } from '../../support/recordingSocket';

afterEach(() => vi.useRealTimers());

function pilot(engine: GameEngine, id = 'pilot', kit: 'scout' | 'hauler' = 'scout') {
  const socket = new RecordingSocket();
  const actor = engine.addPlayer(id, id, socket, { x: 1000, y: 1000 }, kit);
  actor.spawnProtectionTimer = 0;
  actor.asteroidInteractions = 1;
  return { actor, socket };
}
function rock(id: string, ore: AsteroidData['ore'], size = 25): AsteroidData {
  return {
    id,
    ...(ore !== undefined ? { ore } : {}),
    material: ore ?? 'rubble',
    size,
    position: { x: 0, y: 0 },
    velocity: { x: 0, y: 0 },
    health: 75,
    maxHealth: 75,
    vertices: 4,
    offsets: [1, 1, 1, 1],
    jaggedness: 0,
    rotation: 0,
    angularVelocity: 0,
  };
}

test('death repeatedly discards cargo, preserves the bank, and always respawns', () => {
  const engine = new GameEngine(42);
  const { actor } = pilot(engine);
  actor.score = 731;
  for (let death = 0; death < 8; death++) {
    actor.cargo = 90;
    actor.spawnProtectionTimer = 0;
    const beforeDeath = engine.getLoot();
    engine.handleShipDamage(
      actor.id,
      'boundary',
      actor.health + actor.cargo / ECONOMY.cargoPointsPerHp
    );
    expect(actor.cargo).toBe(0);
    expect(engine.getLoot().filter((drop) => drop.kind !== 'points')).toEqual(
      beforeDeath.filter((drop) => drop.kind !== 'points')
    );
    expect(
      engine
        .getLoot()
        .filter((drop) => drop.kind === 'points')
        .reduce((sum, drop) => sum + (drop.points ?? 0), 0)
    ).toBe((death + 1) * 90);
    expect(actor.score).toBe(731);
    expect(actor.respawnTimer).toBe(SHIP.RESPAWN_DELAY_FRAMES);
    for (let frame = 0; frame <= SHIP.RESPAWN_DELAY_FRAMES; frame++) {
      engine.advanceCombatFrame();
    }
    expect(actor.health).toBe(actor.maxHealth);
    expect(actor.exploding).toBe(false);
  }
  expect(actor).not.toHaveProperty('lives');
});

test.each(['scout', 'hauler'] as const)(
  '%s offloads outside the ring and keeps its remainder when it leaves the furnace',
  (kitId) => {
    const engine = new GameEngine(42);
    const { actor } = pilot(engine, 'pilot', kitId);
    const rim = TOWN_HEARTH.radius + hullRadiusForKit(kitId);
    actor.cargo = 400;
    actor.position = { x: rim + 1, y: 0 };
    for (let frame = 0; frame < ECONOMY.offloadIntervalFrames; frame++) {
      engine.depositCargo();
    }
    expect(actor.score).toBe(0);
    actor.position = { x: rim - 1, y: 0 };
    for (let frame = 0; frame < ECONOMY.offloadIntervalFrames - 1; frame++) {
      engine.depositCargo();
    }
    expect(actor.cargo).toBe(400);
    engine.depositCargo();
    expect(actor.score).toBe(25);
    expect(actor.bankedCargo).toBe(25);
    expect(actor.cargo).toBe(375);
    actor.position = { x: 1000, y: 1000 };
    for (let frame = 0; frame < 60; frame++) {
      engine.depositCargo();
    }
    expect(actor.cargo).toBe(375);
    actor.position = { ...TOWN_HEARTH.position };
    for (let frame = 0; frame < 15 * ECONOMY.offloadIntervalFrames; frame++) {
      engine.depositCargo();
    }
    engine.depositCargo();
    expect(actor.score).toBe(400);
    expect(actor.cargo).toBe(0);
    expect(engine.getGameState().settlement.points).toBe(400);
    actor.cargo = 30;
    actor.health = 0;
    for (let frame = 0; frame < 60; frame++) {
      engine.depositCargo();
    }
    expect(actor.cargo).toBe(30);
  }
);

test('offload waits for a fresh full pulse after interruption and rejects inactive ships and dark grates', () => {
  const engine = new GameEngine(42);
  const { actor } = pilot(engine);
  actor.cargo = 28;
  actor.position = { ...TOWN_HEARTH.position };
  for (let frame = 0; frame < 11; frame++) {
    engine.depositCargo();
  }
  actor.exploding = true;
  engine.depositCargo();
  actor.exploding = false;
  for (let frame = 0; frame < 11; frame++) {
    engine.depositCargo();
  }
  expect(actor.cargo).toBe(28);
  engine.depositCargo();
  expect(actor.cargo).toBe(3);
  actor.respawnTimer = 5;
  for (let frame = 0; frame < 12; frame++) {
    engine.depositCargo();
  }
  expect(actor.cargo).toBe(3);
  delete actor.respawnTimer;
  actor.furnaceTransit = {
    sourceId: TOWN_HEARTH.id,
    destinationId: 'street-1-0',
    startedAt: 0,
    durationMs: 1000,
  };
  for (let frame = 0; frame < 12; frame++) {
    engine.depositCargo();
  }
  expect(actor.cargo).toBe(3);
  actor.furnaceTransit = null;
  const dark = civicLot('street-1-0');
  if (!dark) {
    throw new Error('Missing dark furnace');
  }
  actor.position = { ...dark.position };
  for (let frame = 0; frame < 12; frame++) {
    engine.depositCargo();
  }
  expect(actor.cargo).toBe(3);
  actor.position = { ...TOWN_HEARTH.position };
  for (let frame = 0; frame < 12; frame++) {
    engine.depositCargo();
  }
  expect(actor.cargo).toBe(0);
  expect(actor.bankedCargo).toBe(28);
  expect(engine.getGameState().settlement.points).toBe(28);
});

test('points wait for every material and all excess survives multi-tier advancement', () => {
  const state = emptySettlement();
  state.points = 7000;
  state.resources = { ice: 140, metal: 200, rubble: 250, crystal: 0 };
  expect(advanceSettlement(state).level).toBe(1);
  state.resources.crystal = 70;
  expect(advanceSettlement(state)).toEqual({
    level: 3,
    points: 1000,
    resources: { ice: 20, metal: 20, rubble: 10, crystal: 10 },
  });
});

test('refining counts ore once and banks both the hauler and scout rewards', () => {
  const engine = new GameEngine(42);
  const hauler = pilot(engine, 'hauler', 'hauler').actor;
  const scout = pilot(engine, 'scout').actor;
  const ore = rock('ore', 'crystal');
  ore.boost = { phase: 'burning', ownerId: hauler.id, angle: 0 };
  ore.surveyedBy = [scout.id, scout.id];
  engine.addAsteroid(ore);
  engine.processFurnaceDeliveries();
  engine.processFurnaceDeliveries();
  expect(engine.getGameState().settlement.resources.crystal).toBe(10);
  expect(hauler.score).toBe(600);
  expect(scout.score).toBe(600);
  expect(engine.getGameState().settlement.points).toBe(1200);
  const barren = rock('barren', null);
  barren.boost = { phase: 'burning', ownerId: hauler.id, angle: 0 };
  engine.addAsteroid(barren);
  engine.processFurnaceDeliveries();
  expect(engine.getGameState().settlement.resources).toEqual({
    ice: 0,
    metal: 0,
    rubble: 0,
    crystal: 10,
  });
});

test('most old rocks are barren and breaking mineral rocks sacrifices harvest while retaining scans', () => {
  expect(
    Array.from({ length: 1000 }, (_, i) => oreResource(rock(`rock-${i}`, undefined))).filter(
      (resource) => resource === null
    ).length
  ).toBeGreaterThan(600);
  const engine = new GameEngine(42);
  const ore = rock('large-ore', 'metal', 500);
  ore.surveyedBy = ['scout'];
  engine.addAsteroid(ore);
  ore.health = 0;
  const result = engine.handleAsteroidHit(ore.id, 'scout', 'laser');
  expect(result.newAsteroids.length).toBeGreaterThan(0);
  expect(
    result.newAsteroids.every(
      (fragment) => oreResource(fragment) === 'metal' && fragment.surveyedBy?.includes('scout')
    )
  ).toBe(true);
  expect(result.newAsteroids.reduce((sum, fragment) => sum + oreYield(fragment), 0)).toBeLessThan(
    oreYield(ore)
  );
  expect(engine.getGameState().settlement.resources.metal).toBe(0);
});

test('mined cargo pickups survive disposable-loot pressure and expire by elapsed time', () => {
  vi.useFakeTimers();
  vi.setSystemTime(1000000);
  const loot = new LootManager(new RNGService(42));
  for (let i = 0; i < 60; i++) {
    loot.spawnPoints({ x: 0, y: 0 }, 100);
  }
  for (let i = 0; i < 60; i++) {
    loot.spawnShard({ x: 0, y: 0 }, 0);
  }
  expect(loot.savedPoints().reduce((sum, drop) => sum + drop.points, 0)).toBe(6000);
  const revision = loot.pointRevision;
  loot.expire(1);
  expect(loot.pointRevision).toBe(revision);
  vi.setSystemTime(1120001);
  loot.expire(2);
  expect(loot.getAll().filter((drop) => drop.kind === 'points')).toHaveLength(0);
});

test('dummy purchases enforce bank, level, proximity and socket ownership without changing equipment', () => {
  const engine = new GameEngine(42);
  const { actor, socket } = pilot(engine);
  actor.score = 500;
  expect(engine.buyStoreItem(actor.id, 'placeholder-1')).toContain('Town Square');
  actor.position = { x: 0, y: 0 };
  expect(engine.buyStoreItem(actor.id, 'placeholder-2')).toContain('level 2');
  const broadcaster = new GameStateBroadcaster(engine);
  broadcaster.negotiateSnapshot(socket);
  const handler = new MessageHandler(engine, broadcaster);
  const stranger = pilot(engine, 'stranger').socket;
  broadcaster.negotiateSnapshot(stranger);
  const command = { type: 'buyStoreItem', id: actor.id, data: { offerId: 'placeholder-1' } };
  handler.handleMessage(command, stranger);
  expect(actor.score).toBe(500);
  const before = {
    health: actor.health,
    maxHealth: actor.maxHealth,
    mass: actor.mass,
    color: actor.color,
    kitId: actor.kitId,
  };
  handler.handleMessage(command, socket);
  handler.handleMessage(command, socket);
  expect(actor.score).toBe(400);
  expect(actor.purchases).toEqual(['placeholder-1']);
  expect(engine.getPlayer(actor.id)).toBe(actor);
  expect(actor).toMatchObject(before);
  expect(engine.getGameState().settlement.points).toBe(0);
});

test('a long absence and a smaller kit preserve cargo at its field position with excess discarded', () => {
  vi.useFakeTimers();
  vi.setSystemTime(1000000);
  const engine = new GameEngine(42);
  const { actor, socket } = pilot(engine, 'hauler', 'hauler');
  const registration = engine.registerPilot(actor, socket);
  if (!registration.ok) {
    throw new Error('Registration failed');
  }
  actor.cargo = 1200;
  actor.score = 70;
  engine.removePlayer(actor.id);
  vi.advanceTimersByTime(60000);
  const resumed = engine.resumePilot(registration.resumeToken, new RecordingSocket(), 'scout');
  if (!resumed.ok) {
    throw new Error('Resume failed');
  }
  expect(resumed.actor.position).toEqual({ x: 1000, y: 1000 });
  expect(resumed.actor.cargo).toBe(500);
  expect(resumed.actor.score).toBe(70);
  expect(
    engine
      .getLoot()
      .filter((drop) => drop.kind === 'points')
      .reduce((sum, drop) => sum + (drop.points ?? 0), 0)
  ).toBe(0);
});
