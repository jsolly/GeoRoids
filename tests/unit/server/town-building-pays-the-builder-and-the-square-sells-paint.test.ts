/* @vitest-environment node */
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test } from 'vitest';
import { MessageHandler } from '../../../server/communication/MessageHandler';
import { GameEngine } from '../../../server/core/GameEngine';
import { GameStateBroadcaster } from '../../../server/services/GameStateBroadcaster';
import { InlineWorldPersistence } from '../../../server/world/InlineWorldPersistence';
import { WorldStore } from '../../../server/world/WorldStore';
import { civicLot, furnaceReward } from '../../../shared/furnaces';
import {
  insideTownStore,
  shipPaintById,
  TOWN_STORE_ISSUE,
  TOWN_STORE_RADIUS,
} from '../../../shared/townStore';
import { WORLD } from '../../../shared/world';
import type { AsteroidData } from '../../../shared-types';
import { PALETTE } from '../../../src/constants';
import { RecordingSocket } from '../../support/recordingSocket';

const eastStreet = civicLot('street-1-0');
const secondRing = civicLot('street-2-0');
const ember = shipPaintById('ember');
const violet = shipPaintById('violet');
if (!eastStreet || !secondRing || !ember || !violet) {
  throw new Error('Missing street lots or hull paints');
}
const street = eastStreet;
const child = secondRing;

function cargo(id: string): AsteroidData {
  return {
    id,
    position: { x: 0, y: 0 },
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

test('a street the Scout paid for raises only that pilot furnace payout', () => {
  const engine = new GameEngine(42);
  const hauler = engine.addPlayer(
    'hauler',
    'Hauler',
    new RecordingSocket(),
    { x: 0, y: 0 },
    'hauler'
  );
  const scoutSocket = new RecordingSocket();
  const scout = engine.addPlayer('scout', 'scout', scoutSocket, { ...street.position }, 'scout');
  scout.position = { ...street.position };
  scout.asteroidInteractions = 1;
  const registered = engine.registerPilot(scout, scoutSocket);
  assert(registered.ok);
  scout.abilityCooldownFrames = 0;
  scout.score = street.cost;
  expect(engine.useAbility(scout.id)).toBe(true);
  expect(engine.getGameState().civicModules).toEqual([
    { id: street.id, builderName: 'scout', builderId: scout.id },
  ]);
  hauler.score = 0;
  scout.score = 0;
  const base = deliver(engine, 'first-haul', hauler.id, scout.id);
  expect(base).toBe(300);
  expect(scout.score).toBe(330);
  expect(hauler.score).toBe(300);

  scout.position = { ...child.position };
  scout.abilityCooldownFrames = 0;
  scout.score = child.cost;
  expect(engine.useAbility(scout.id)).toBe(true);
  const before = { scout: scout.score, hauler: hauler.score };
  const second = deliver(engine, 'second-haul', hauler.id, scout.id);
  expect(second).toBe(300);
  expect(scout.score - before.scout).toBe(360);
  expect(hauler.score - before.hauler).toBe(300);

  scout.name = 'New name';
  const renamed = deliver(engine, 'renamed-haul', hauler.id, scout.id);
  expect(renamed).toBe(300);
  expect(scout.score - (before.scout + 360)).toBe(360);
  expect(engine.getGameState().civicModules?.[0]?.builderName).toBe('scout');
});

test('an unnamed street grants no delivery bonus', () => {
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
        civicModules: [{ id: street.id, builderName: '' }],
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

test('Town Square sells a hull paint once and keeps it across a restart', () => {
  const directory = mkdtempSync(join(tmpdir(), 'town-store-'));
  const path = join(directory, 'world.sqlite');
  const firstStore = new WorldStore(path);
  try {
    const engine = new GameEngine(42, undefined, new InlineWorldPersistence(firstStore));
    const socket = new RecordingSocket();
    const pilot = engine.addPlayer('pilot', 'Pilot', socket, { x: 0, y: 0 }, 'hauler');
    pilot.position = { x: 0, y: 0 };
    pilot.asteroidInteractions = 1;
    const registered = engine.registerPilot(pilot, socket);
    assert(registered.ok);
    const bystander = engine.addPlayer(
      'rich',
      'Rich',
      new RecordingSocket(),
      { x: 10, y: 0 },
      'scout'
    );
    bystander.score = ember.cost * 3;
    expect(engine.buyShipPaint(pilot.id, ember.id)).toBe(`You need ${ember.cost} more score`);
    expect(pilot.score).toBe(0);
    expect(pilot.color).toBe(PALETTE.REMOTE);
    pilot.score = ember.cost;
    pilot.position = { x: TOWN_STORE_RADIUS + 50, y: 0 };
    expect(insideTownStore(pilot.position)).toBe(false);
    expect(engine.buyShipPaint(pilot.id, ember.id)).toBe(TOWN_STORE_ISSUE.AWAY);
    expect(pilot.score).toBe(ember.cost);
    expect(pilot.color).toBe(PALETTE.REMOTE);
    pilot.position = { x: 0, y: 0 };
    expect(engine.buyShipPaint(pilot.id, ember.id)).toBeUndefined();
    expect(pilot.score).toBe(0);
    expect(pilot.color).toBe(ember.color);
    expect(bystander.score).toBe(ember.cost * 3);
    expect(engine.buyShipPaint(pilot.id, ember.id)).toBe(TOWN_STORE_ISSUE.WORN);
    expect(pilot.score).toBe(0);
    pilot.score = ember.cost;
    pilot.health = 0;
    expect(engine.buyShipPaint(pilot.id, ember.id)).toBe(TOWN_STORE_ISSUE.CLOSED);
    expect(pilot.score).toBe(ember.cost);
    expect(pilot.color).toBe(ember.color);
    pilot.health = 100;
    pilot.score = violet.cost;
    const handler = new MessageHandler(engine, new GameStateBroadcaster(engine));
    handler.handleMessage(
      { type: 'buyShipPaint', id: pilot.id, data: { paintId: 'nope' } },
      socket
    );
    expect(socket.lastReceived('townStoreResult')).toBeUndefined();
    handler.handleMessage(
      { type: 'buyShipPaint', id: bystander.id, data: { paintId: ember.id } },
      socket
    );
    expect(bystander.score).toBe(ember.cost * 3);
    handler.handleMessage(
      { type: 'buyShipPaint', id: pilot.id, data: { paintId: 'violet' } },
      socket
    );
    const result = socket.lastReceived('townStoreResult');
    expect(result?.data).toEqual({
      message: 'Violet is on your hull',
      score: 0,
      color: shipPaintById('violet')?.color,
    });
    expect(pilot.color).toBe(shipPaintById('violet')?.color);
    engine.removePlayer(pilot.id);
    engine.removePlayer(bystander.id);
    const db = new DatabaseSync(path);
    const row = db.prepare('SELECT json FROM pilots WHERE id=?').get(pilot.id) as { json: string };
    db.close();
    expect(JSON.parse(row.json)).toMatchObject({
      hullColor: shipPaintById('violet')?.color,
      score: 0,
    });
    firstStore.close();
    const secondStore = new WorldStore(path);
    try {
      const restarted = new GameEngine(99, undefined, new InlineWorldPersistence(secondStore));
      const resumed = restarted.resumePilot(
        registered.resumeToken,
        new RecordingSocket(),
        'hauler'
      );
      assert(resumed.ok);
      expect(resumed.actor.color).toBe(shipPaintById('violet')?.color);
      expect(resumed.actor.score).toBe(0);
    } finally {
      secondStore.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
