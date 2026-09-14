import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { AsteroidManager } from '../../../server/core/AsteroidManager';
import { GameEngine } from '../../../server/core/GameEngine';
import { RNGService } from '../../../server/core/RNGService';
import { RegionalAsteroidField } from '../../../server/world/RegionalAsteroidField';
import { WorldStore } from '../../../server/world/WorldStore';
import { explorationCellAt, isCellExplored } from '../../../shared/exploration';
import { FURNACES } from '../../../shared/furnaces';
import { nearbyWorldRows, WORLD } from '../../../shared/world';
import type { AsteroidData } from '../../../shared-types';
import { RecordingSocket } from '../../support/recordingSocket';

const directories: string[] = [];
const stores: WorldStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) {
    store.close();
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function database(path: string): WorldStore {
  const store = new WorldStore(path);
  stores.push(store);
  return store;
}
function pilot(
  engine: GameEngine,
  id: string,
  kit: 'surveyor' | 'hauler',
  position = { x: 0, y: 0 }
) {
  const socket = new RecordingSocket();
  const actor = engine.addPlayer(id, id, socket, position, kit);
  actor.asteroidInteractions = 1;
  const registered = engine.registerPilot(actor, socket);
  assert(registered.ok);
  return { actor, socket, token: registered.resumeToken };
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

test('a restart preserves mined sectors, shared discoveries and offline Surveyor delivery credit', () => {
  const directory = mkdtempSync(join(tmpdir(), 'georoids-world-'));
  directories.push(directory);
  const path = join(directory, 'world.sqlite');
  const firstStore = database(path);
  const first = new GameEngine(82, undefined, firstStore);
  const scout = pilot(first, 'scout', 'surveyor');
  const hauler = pilot(first, 'hauler', 'hauler', { x: 80, y: 0 });
  for (const rock of first.getAllAsteroids()) {
    first.removeAsteroid(rock.id);
  }
  const rock = cargo('delivery', { x: 180, y: 0 });
  first.addAsteroid(rock);
  expect(first.useAbility(scout.actor.id)).toBe(true);
  expect(rock.surveyedBy).toEqual(['scout']);
  first.removePlayer('scout');
  expect(first.useAbility(hauler.actor.id)).toBe(true);
  const station = FURNACES[0];
  assert(station);
  rock.position = { ...station.position };
  hauler.actor.position = { x: station.position.x + 100, y: station.position.y };
  first.processFurnaceDeliveries();
  const points = 300;
  expect(first.getPlayer('hauler')?.score).toBe(points);
  expect(
    first.drainFurnaceDeliveries()[0]?.rewards.find((reward) => reward.playerId === 'scout')?.points
  ).toBe(points);
  first.removePlayer('hauler');
  expect(first.isGamePaused()).toBe(true);
  firstStore.close();
  stores.splice(stores.indexOf(firstStore), 1);

  const second = new GameEngine(999, undefined, database(path));
  expect(second.getTerrainSeed()).toBe(82);
  const resumed = second.resumePilot(scout.token, new RecordingSocket());
  assert(resumed.ok);
  expect(resumed.actor.id).toBe('scout');
  expect(resumed.actor.score).toBe(points);
  expect(second.getAsteroid('delivery')).toBeUndefined();
  expect(second.getAllAsteroids()).toHaveLength(0);
  const cell = explorationCellAt({ x: 900, y: 0 });
  assert(cell !== null);
  expect(isCellExplored(second.getGameState().exploration, cell)).toBe(true);
  expect(second.resumePilot('f'.repeat(64), new RecordingSocket()).ok).toBe(false);
  expect(second.resumePilot(scout.token, new RecordingSocket()).ok).toBe(false);
});

test('travelling far across the world loads local ore and returning does not replenish mined deposits', () => {
  const engine = new GameEngine(82);
  const traveller = pilot(engine, 'traveller', 'surveyor');
  const original = engine
    .getAllAsteroids()
    .find((rock) => Math.abs(rock.position.x) < 1_000 && Math.abs(rock.position.y) < 1_000);
  assert(original);
  engine.removeAsteroid(original.id);
  traveller.actor.position = { x: 40_000, y: 24_000 };
  engine.ensureAsteroidField();
  expect(engine.getAllAsteroids().length).toBeLessThan(25 * WORLD.depositsPerSector);
  expect(
    nearbyWorldRows(engine.getAllAsteroids(), traveller.actor.position).length
  ).toBeGreaterThan(80);
  expect(
    engine
      .getAllAsteroids()
      .every((rock) => Math.abs(rock.position.x - traveller.actor.position.x) < 5_000)
  ).toBe(true);
  traveller.actor.position = { x: 0, y: 0 };
  engine.ensureAsteroidField();
  expect(engine.getAsteroid(original.id)).toBeUndefined();
  expect(
    nearbyWorldRows(engine.getAllAsteroids(), traveller.actor.position).length
  ).toBeGreaterThan(80);
});

test('a drifting deposit crosses into a sleeping sector once and preserves that sector’s native ore', () => {
  const store = database(':memory:');
  const field = new RegionalAsteroidField(82, store);
  const manager = new AsteroidManager(new RNGService(82));
  field.update(manager, [{ x: 0, y: 0 }]);
  const drift = manager.getAllAsteroids()[0];
  assert(drift);
  const originalPosition = { ...drift.position };
  drift.position = { x: 8_200, y: 200 };
  const save = () => {
    store.checkpoint(
      {
        seed: 82,
        startedAt: 1,
        generation: WORLD.generation,
        exploration: [],
        completedSectors: [],
      },
      field.checkpoint(manager),
      []
    );
    field.saved();
  };
  save();
  save();
  expect(manager.getAsteroid(drift.id)).toBeUndefined();
  const sleeping = store.loadSector('4,0');
  assert(sleeping);
  expect(sleeping.filter((rock) => rock.id === drift.id)).toHaveLength(1);
  expect(sleeping).toHaveLength(25);

  field.update(manager, [{ x: 8_200, y: 200 }]);
  const arrived = manager.getAsteroid(drift.id);
  assert(arrived);
  arrived.position = { x: 16_200, y: 200 };
  save();
  expect(store.loadSector('4,0')?.some((rock) => rock.id === drift.id)).toBe(false);
  expect(store.loadSector('8,0')?.filter((rock) => rock.id === drift.id)).toHaveLength(1);
  field.update(manager, [originalPosition]);
  expect(manager.getAsteroid(drift.id)).toBeUndefined();
});

test('a private-token reconnect preserves progress while selecting the Hauler kit', () => {
  const engine = new GameEngine(82);
  const original = pilot(engine, 'scout', 'surveyor', { x: 200, y: 300 });
  original.actor.lives = 2;
  original.actor.score = 450;
  const replacement = new RecordingSocket();
  const resumed = engine.resumePilot(original.token, replacement, 'hauler');
  assert(resumed.ok);
  expect(resumed.actor).toBe(original.actor);
  expect(resumed.actor).toMatchObject({
    id: 'scout',
    kitId: 'hauler',
    lives: 2,
    score: 450,
    ws: replacement,
    position: { x: 200, y: 300 },
  });
  expect(engine.getPlayerCount()).toBe(1);
  engine.stopGameLoop();
});

test('resuming during an explosion keeps the pending life loss until the server respawns', () => {
  const engine = new GameEngine(82);
  const original = pilot(engine, 'scout', 'surveyor');
  original.actor.spawnProtectionTimer = 0;
  original.actor.score = 210;
  expect(engine.handleShipDamage('scout', 'asteroid', original.actor.health).isDestroyed).toBe(
    true
  );
  const remaining = original.actor.respawnTimer;
  const resumed = engine.resumePilot(original.token, new RecordingSocket());
  assert(resumed.ok);
  expect(resumed.actor).toBe(original.actor);
  expect(resumed.actor).toMatchObject({
    health: 0,
    lives: 2,
    score: 210,
    exploding: true,
    respawnTimer: remaining,
  });
  assert(remaining !== undefined);
  for (let frame = 0; frame <= remaining; frame++) {
    engine.advanceCombatFrame();
  }
  expect(resumed.actor.health).toBe(resumed.actor.maxHealth);
  expect(resumed.actor.lives).toBe(2);
  expect(resumed.actor.score).toBe(210);
  expect(resumed.actor.exploding).toBe(false);
  expect(resumed.actor.spawnProtectionTimer).toBeGreaterThan(0);
  engine.stopGameLoop();
});
