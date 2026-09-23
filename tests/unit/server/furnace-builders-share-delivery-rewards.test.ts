import { strict as assert } from 'node:assert';
/* @vitest-environment node */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { GameEngine } from '../../../server/core/GameEngine';
import { InlineWorldPersistence } from '../../../server/world/InlineWorldPersistence';
import { WorldStore } from '../../../server/world/WorldStore';
import { civicLot, furnaceReward } from '../../../shared/furnaces';
import { WORLD } from '../../../shared/world';
import type { AsteroidData } from '../../../shared-types';
import { RecordingSocket } from '../../support/recordingSocket';

const eastFurnace = civicLot('street-1-0');
const secondRing = civicLot('street-2-0');
if (!eastFurnace || !secondRing) {
  throw new Error('Missing furnace lots or hull paints');
}
const furnace = eastFurnace;
const child = secondRing;

function cargo(id: string): AsteroidData {
  return {
    id,
    position: { x: 0, y: 0 },
    velocity: { x: 0, y: 0 },
    size: 25,
    material: 'metal',
    ore: 'metal',
    health: 75,
    maxHealth: 75,
    rotation: 0,
    angularVelocity: 0,
    jaggedness: 0.2,
    offsets: [1, 1, 1, 1],
    vertices: 4,
  };
}

function deliver(engine: GameEngine, id: string, haulerId: string, scoutId: string): number {
  for (const rock of engine.getAllAsteroids()) {
    engine.removeAsteroid(rock.id);
  }
  const rock = cargo(id);
  rock.boost = { phase: 'burning', ownerId: haulerId, angle: 0 };
  rock.surveyedBy = [scoutId];
  engine.addAsteroid(rock);
  engine.processFurnaceDeliveries();
  return furnaceReward(rock);
}

test('building multiple named furnaces keeps delivery payouts equal for all contributors', () => {
  const engine = new GameEngine(42);
  const hauler = engine.addPlayer(
    'hauler',
    'Hauler',
    new RecordingSocket(),
    { x: 0, y: 0 },
    'hauler'
  );
  const scoutSocket = new RecordingSocket();
  const scout = engine.addPlayer('scout', 'scout', scoutSocket, { ...furnace.position }, 'scout');
  scout.position = { ...furnace.position };
  scout.asteroidInteractions = 1;
  const registered = engine.registerPilot(scout, scoutSocket);
  assert(registered.ok);
  scout.abilityCooldownFrames = 0;
  scout.score = furnace.cost;
  expect(engine.useAbility(scout.id)).toBe(true);
  expect(engine.getGameState().civicModules).toEqual([
    { id: furnace.id, builderName: 'scout', builderId: scout.id },
  ]);
  hauler.score = 0;
  scout.score = 0;
  const base = deliver(engine, 'first-haul', hauler.id, scout.id);
  expect(base).toBe(300);
  expect(scout.score).toBe(300);
  expect(hauler.score).toBe(300);

  scout.position = { ...child.position };
  scout.abilityCooldownFrames = 0;
  scout.score = child.cost;
  expect(engine.useAbility(scout.id)).toBe(true);
  const before = { scout: scout.score, hauler: hauler.score };
  const second = deliver(engine, 'second-haul', hauler.id, scout.id);
  expect(second).toBe(300);
  expect(scout.score - before.scout).toBe(300);
  expect(hauler.score - before.hauler).toBe(300);

  scout.name = 'New name';
  const renamed = deliver(engine, 'renamed-haul', hauler.id, scout.id);
  expect(renamed).toBe(300);
  expect(scout.score - (before.scout + 300)).toBe(300);
  expect(engine.getGameState().civicModules?.[0]?.builderName).toBe('scout');

  const offlineScore = scout.score;
  engine.removePlayer(scout.id);
  const offlineReward = deliver(engine, 'offline-haul', hauler.id, scout.id);
  const resumed = engine.resumePilot(registered.resumeToken, new RecordingSocket(), 'scout');
  assert(resumed.ok);
  expect(resumed.actor.score).toBe(offlineScore + offlineReward);
  expect(offlineReward).toBe(300);
  expect(engine.getGameState().civicModules).toHaveLength(2);
});

test('a saved unnamed furnace still pays every contributor the material reward', () => {
  const directory = mkdtempSync(join(tmpdir(), 'town-unnamed-'));
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
        civicModules: [{ id: furnace.id, builderName: '' }],
      },
      new Map(),
      []
    );
    const engine = new GameEngine(42, undefined, new InlineWorldPersistence(store));
    const hauler = engine.addPlayer(
      'hauler',
      'Hauler',
      new RecordingSocket(),
      { x: 0, y: 0 },
      'hauler'
    );
    const scout = engine.addPlayer(
      'scout',
      'scout',
      new RecordingSocket(),
      { x: 10, y: 0 },
      'scout'
    );
    const base = deliver(engine, 'legacy', hauler.id, scout.id);
    expect(hauler.score).toBe(base);
    expect(scout.score).toBe(base);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
