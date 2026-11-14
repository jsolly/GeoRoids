/* @vitest-environment node */

import { afterEach, expect, test, vi } from 'vitest';
import { MessageHandler } from '../../../server/communication/MessageHandler';
import { GameEngine } from '../../../server/core/GameEngine';
import { LootManager } from '../../../server/core/LootManager';
import { RNGService } from '../../../server/core/RNGService';
import { SettlementLedger } from '../../../server/core/SettlementLedger';
import { GameStateBroadcaster } from '../../../server/services/GameStateBroadcaster';
import { DAMAGE, SHIP } from '../../../shared/constants/gameplay';
import {
  advanceSettlement,
  ECONOMY,
  emptySettlement,
  oreResource,
  oreYield,
} from '../../../shared/economy';
import { civicLot, TOWN_HEARTH, TOWN_SPAWN_RADIUS } from '../../../shared/furnaces';
import { hullRadiusForKit } from '../../../shared/shipKits';
import type { AsteroidData } from '../../../shared-types';
import { RecordingSocket } from '../../support/recordingSocket';

afterEach(() => vi.useRealTimers());

function pilot(engine: GameEngine, id = 'pilot', kit: 'scout' | 'hauler' = 'scout') {
  const socket = new RecordingSocket();
  const actor = engine.addPlayer(id, id, socket, { x: 1000, y: 1000 }, kit);
  actor.spawnProtectionTimer = 0;
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
  const outerFurnace = civicLot('street-1-0');
  if (!outerFurnace) {
    throw new Error('Missing outer furnace');
  }
  actor.position = { ...outerFurnace.position };
  actor.score = outerFurnace.cost + 731;
  actor.abilityCooldownFrames = 0;
  expect(engine.useAbility(actor.id)).toBe(true);
  expect(engine.getGameState().civicModules).toContainEqual({
    id: outerFurnace.id,
    builderName: actor.name,
    builderId: actor.id,
  });
  expect(actor.score).toBe(731);
  for (let death = 0; death < 8; death++) {
    actor.position = { ...outerFurnace.position };
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
    expect(Math.hypot(actor.position.x, actor.position.y)).toBeCloseTo(TOWN_SPAWN_RADIUS);
  }
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
      engine.cargoOffload.advance();
    }
    expect(actor.score).toBe(0);
    actor.position = { x: rim - 1, y: 0 };
    for (let frame = 0; frame < ECONOMY.offloadIntervalFrames - 1; frame++) {
      engine.cargoOffload.advance();
    }
    expect(actor.cargo).toBe(400);
    engine.cargoOffload.advance();
    expect(actor.score).toBe(25);
    expect(actor.bankedCargo).toBe(25);
    expect(actor.cargo).toBe(375);
    actor.position = { x: 1000, y: 1000 };
    for (let frame = 0; frame < 60; frame++) {
      engine.cargoOffload.advance();
    }
    expect(actor.cargo).toBe(375);
    actor.position = { ...TOWN_HEARTH.position };
    for (let frame = 0; frame < 15 * ECONOMY.offloadIntervalFrames; frame++) {
      engine.cargoOffload.advance();
    }
    engine.cargoOffload.advance();
    expect(actor.score).toBe(400);
    expect(actor.cargo).toBe(0);
    expect(engine.getGameState().settlement.points).toBe(400);
    actor.cargo = 30;
    actor.health = 0;
    for (let frame = 0; frame < 60; frame++) {
      engine.cargoOffload.advance();
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
    engine.cargoOffload.advance();
  }
  actor.exploding = true;
  engine.cargoOffload.advance();
  actor.exploding = false;
  for (let frame = 0; frame < 11; frame++) {
    engine.cargoOffload.advance();
  }
  expect(actor.cargo).toBe(28);
  engine.cargoOffload.advance();
  expect(actor.cargo).toBe(3);
  actor.respawnTimer = 5;
  for (let frame = 0; frame < 12; frame++) {
    engine.cargoOffload.advance();
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
    engine.cargoOffload.advance();
  }
  expect(actor.cargo).toBe(3);
  actor.furnaceTransit = null;
  const dark = civicLot('street-1-0');
  if (!dark) {
    throw new Error('Missing dark furnace');
  }
  actor.position = { ...dark.position };
  for (let frame = 0; frame < 12; frame++) {
    engine.cargoOffload.advance();
  }
  expect(actor.cargo).toBe(3);
  actor.position = { ...TOWN_HEARTH.position };
  for (let frame = 0; frame < 12; frame++) {
    engine.cargoOffload.advance();
  }
  expect(actor.cargo).toBe(0);
  expect(actor.bankedCargo).toBe(28);
  expect(engine.getGameState().settlement.points).toBe(28);
});

test('full frames bank exact pulses while the smaller combat-only frame leaves the cadence alone', () => {
  const engine = new GameEngine(42);
  try {
    const { actor } = pilot(engine);
    engine.createAsteroids(0);
    actor.position = { ...TOWN_HEARTH.position };
    actor.cargo = 28;
    for (let frame = 0; frame < 11; frame++) {
      engine.advanceOneFrame();
    }
    expect(actor.cargo).toBe(28);
    expect(actor.score).toBe(0);
    for (let frame = 0; frame < 20; frame++) {
      engine.advanceCombatFrame();
    }
    expect(actor.cargo).toBe(28);
    expect(actor.bankedCargo ?? 0).toBe(0);
    expect(engine.getGameState().settlement.points).toBe(0);
    engine.advanceOneFrame();
    expect(actor.cargo).toBe(3);
    expect(actor.score).toBe(25);
    expect(actor.bankedCargo).toBe(25);
    expect(engine.getGameState().settlement.points).toBe(25);
    for (let frame = 0; frame < 12; frame++) {
      engine.advanceOneFrame();
    }
    expect(actor.cargo).toBe(0);
    expect(actor.score).toBe(28);
    expect(actor.bankedCargo).toBe(28);
    expect(engine.getGameState().settlement.points).toBe(28);
  } finally {
    engine.stopGameLoop();
  }
});

test.each(['death', 'separation'] as const)(
  'full-frame %s resolves before a due cargo pulse',
  (outcome) => {
    const engine = new GameEngine(42);
    try {
      const { actor } = pilot(engine);
      engine.createAsteroids(0);
      const rim = TOWN_HEARTH.radius + hullRadiusForKit(actor.kitId);
      actor.position = { x: rim - 1, y: 0 };
      actor.velocity = { x: 0, y: 0 };
      actor.cargo = outcome === 'death' ? 1 : 400;
      if (outcome === 'death') {
        actor.health = 1;
      }
      for (let frame = 0; frame < 11; frame++) {
        engine.cargoOffload.advance();
      }
      const impact = rock('banking-impact', null, outcome === 'death' ? 25 : 500);
      impact.position = { x: actor.position.x - 1, y: 0 };
      engine.addAsteroid(impact);

      engine.advanceOneFrame();

      expect(actor.score).toBe(0);
      expect(actor.bankedCargo ?? 0).toBe(0);
      expect(engine.getGameState().settlement.points).toBe(0);
      if (outcome === 'death') {
        expect(actor.health).toBe(0);
        expect(actor.cargo).toBe(0);
      } else {
        expect(engine.getAsteroid(impact.id)).toBeDefined();
        expect(actor.health).toBe(actor.maxHealth);
        expect(actor.position.x).toBeGreaterThan(rim);
        expect(actor.cargo).toBe(400 - DAMAGE.ASTEROID_COLLISION * ECONOMY.cargoPointsPerHp);
        actor.position = { ...TOWN_HEARTH.position };
        for (let frame = 0; frame < 11; frame++) {
          engine.cargoOffload.advance();
        }
        expect(actor.score).toBe(0);
        engine.cargoOffload.advance();
        expect(actor.score).toBe(25);
      }
    } finally {
      engine.stopGameLoop();
    }
  }
);

test.each(['health', 'explosion', 'respawn', 'empty', 'transit', 'outside'] as const)(
  '%s interruption retires the prior eleven eligible cargo steps',
  (interruption) => {
    const engine = new GameEngine(42);
    try {
      const { actor } = pilot(engine);
      actor.position = { ...TOWN_HEARTH.position };
      actor.cargo = 28;
      for (let frame = 0; frame < 11; frame++) {
        engine.cargoOffload.advance();
      }
      switch (interruption) {
        case 'health':
          actor.health = 0;
          break;
        case 'explosion':
          actor.exploding = true;
          break;
        case 'respawn':
          actor.respawnTimer = 0;
          break;
        case 'empty':
          actor.cargo = 0;
          break;
        case 'transit':
          actor.furnaceTransit = {
            sourceId: TOWN_HEARTH.id,
            destinationId: 'street-1-0',
            startedAt: 0,
            durationMs: 1000,
          };
          break;
        case 'outside':
          actor.position = { x: 1000, y: 1000 };
          break;
        default: {
          const exhaustive: never = interruption;
          throw new Error(`Unknown cargo interruption: ${exhaustive}`);
        }
      }
      engine.cargoOffload.advance();
      actor.health = actor.maxHealth;
      actor.exploding = false;
      delete actor.respawnTimer;
      actor.cargo = 28;
      actor.furnaceTransit = null;
      actor.position = { ...TOWN_HEARTH.position };
      for (let frame = 0; frame < 11; frame++) {
        engine.cargoOffload.advance();
      }
      expect(actor.cargo).toBe(28);
      expect(actor.score).toBe(0);
      expect(actor.bankedCargo ?? 0).toBe(0);
      engine.cargoOffload.advance();
      expect(actor.cargo).toBe(3);
      expect(actor.score).toBe(25);
      expect(actor.bankedCargo).toBe(25);
      expect(engine.getGameState().settlement.points).toBe(25);
    } finally {
      engine.stopGameLoop();
    }
  }
);

test('moving between two lit furnaces begins a fresh cargo pulse', () => {
  const engine = new GameEngine(42);
  try {
    const { actor } = pilot(engine);
    const outer = civicLot('street-1-0');
    if (!outer) {
      throw new Error('Missing outer furnace');
    }
    actor.position = { ...outer.position };
    actor.score = outer.cost;
    actor.abilityCooldownFrames = 0;
    expect(engine.useAbility(actor.id)).toBe(true);
    actor.cargo = 28;
    actor.position = { ...TOWN_HEARTH.position };
    for (let frame = 0; frame < 11; frame++) {
      engine.cargoOffload.advance();
    }
    actor.position = { ...outer.position };
    for (let frame = 0; frame < 11; frame++) {
      engine.cargoOffload.advance();
    }
    expect(actor.cargo).toBe(28);
    expect(actor.score).toBe(0);
    engine.cargoOffload.advance();
    expect(actor.cargo).toBe(3);
    expect(actor.score).toBe(25);
    expect(actor.bankedCargo).toBe(25);
    expect(engine.getGameState().settlement.points).toBe(25);
  } finally {
    engine.stopGameLoop();
  }
});

test('diagnostic clearing keeps retained-actor cadence while full replacement cannot inherit it', () => {
  const engine = new GameEngine(42);
  try {
    const { actor } = pilot(engine);
    actor.position = { ...TOWN_HEARTH.position };
    actor.cargo = 28;
    for (let frame = 0; frame < 11; frame++) {
      engine.cargoOffload.advance();
    }
    engine.prepareDiagnosticWorld('combat');
    expect(engine.getPlayer(actor.id)).toBe(actor);
    engine.cargoOffload.advance();
    expect(actor.cargo).toBe(3);
    expect(actor.score).toBe(25);
    expect(actor.bankedCargo).toBe(25);
    for (let frame = 0; frame < 11; frame++) {
      engine.cargoOffload.advance();
    }
    engine.resetForTesting();
    const replacement = pilot(engine, actor.id).actor;
    expect(replacement).not.toBe(actor);
    replacement.position = { ...TOWN_HEARTH.position };
    replacement.cargo = 28;
    for (let frame = 0; frame < 11; frame++) {
      engine.cargoOffload.advance();
    }
    expect(replacement.cargo).toBe(28);
    expect(replacement.score).toBe(0);
    expect(actor.cargo).toBe(3);
    engine.cargoOffload.advance();
    expect(replacement.cargo).toBe(3);
    expect(replacement.score).toBe(25);
    expect(replacement.bankedCargo).toBe(25);
    expect(engine.getGameState().settlement.points).toBe(25);
  } finally {
    engine.stopGameLoop();
  }
});

test('points wait for every material and all excess survives multi-tier advancement', () => {
  const state = emptySettlement();
  state.points = 7000;
  state.resources = { ice: 140, metal: 200, rubble: 250, crystal: 0 };
  expect(advanceSettlement(state).level).toBe(1);
  const ledger = new SettlementLedger(state);
  expect(ledger.current()).toBe(state);
  ledger.addPoints(0);
  const afterPoints = ledger.current();
  expect(afterPoints).not.toBe(state);
  expect(afterPoints).toEqual(state);
  ledger.addOre(null, 0);
  const beforeCrystal = ledger.current();
  expect(beforeCrystal).not.toBe(afterPoints);
  expect(beforeCrystal.resources).not.toBe(afterPoints.resources);
  expect(beforeCrystal).toEqual(state);
  ledger.addOre('crystal', 70);
  expect(ledger.current()).toEqual({
    level: 3,
    points: 1000,
    resources: { ice: 20, metal: 20, rubble: 10, crystal: 10 },
  });
  expect(state.resources.crystal).toBe(0);
  expect(beforeCrystal.resources.crystal).toBe(0);
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
  const loot = new LootManager(new RNGService(42), () => Date.now());
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
  const registration = engine.pilotSessions.register({ actor: actor, socket: socket });
  if (!registration.ok) {
    throw new Error('Registration failed');
  }
  actor.cargo = 1200;
  actor.score = 70;
  engine.removePlayer(actor.id);
  vi.advanceTimersByTime(60000);
  const resumed = engine.pilotSessions.resume({
    token: registration.resumeToken,
    socket: new RecordingSocket(),
    requestedKit: 'scout',
  });
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
