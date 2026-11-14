/* @vitest-environment node */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, test } from 'vitest';
import { GameEngine } from '../../../server/core/GameEngine';
import { ServerClock } from '../../../server/core/ServerClock';
import { GameStateBroadcaster } from '../../../server/services/GameStateBroadcaster';
import {
  legacyWorldDigest,
  migrateCooperativeWorld,
} from '../../../server/world/cooperativeSchema';
import { InlineWorldPersistence } from '../../../server/world/InlineWorldPersistence';
import { WorldStore } from '../../../server/world/WorldStore';
import { DAMAGE } from '../../../shared/constants/gameplay';
import { COOPERATIVE } from '../../../shared/cooperativeRules';
import { explorationCellAt, isCellExplored } from '../../../shared/exploration';
import { frontierSite } from '../../../shared/frontier';
import { FurnaceField } from '../../../shared/furnaceField';
import { CIVIC_LOTS, TOWN_HEARTH } from '../../../shared/furnaces';
import { litTravelDestinations } from '../../../shared/furnaceTravel';
import { SnapshotDecoder } from '../../../shared/snapshotProtocol';
import type { AsteroidData, CooperativeRecord } from '../../../shared-types';
import { decodeSnapshotMessage } from '../../support/decodeSnapshotMessage';
import { RecordingSocket } from '../../support/recordingSocket';
import { resolveToolFlights } from '../../support/tool-flight';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) {
    c();
  }
});
function scenario(records: CooperativeRecord[] = []) {
  const dir = mkdtempSync(join(tmpdir(), 'physical-supply-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'world.sqlite');
  new WorldStore(path).close();
  const db = new DatabaseSync(path);
  migrateCooperativeWorld(db, legacyWorldDigest(db));
  db.exec('UPDATE cooperative_schema SET activated=1');
  db.close();
  const store = new WorldStore(path);
  cleanups.push(() => store.close());
  store.checkpoint(undefined, new Map(), [], undefined, { records, removed: [] });
  const engine = new GameEngine(
    82,
    new ServerClock({ wallNow: () => 500_000, monotonicNow: () => 0 }),
    new InlineWorldPersistence(store)
  );
  cleanups.push(() => engine.stopGameLoop());
  const socket = new RecordingSocket();
  const pilot = engine.addPlayer('hauler', 'Hauler', socket, { x: 0, y: 0 }, 'hauler');
  engine.pilotSessions.register({ actor: pilot, socket: socket });
  pilot.haulerUtility = 'tow_cable';
  return { engine, pilot, store, socket };
}
function ore(id: string): AsteroidData {
  return {
    id,
    position: { x: 0, y: 0 },
    velocity: { x: 0, y: 0 },
    size: 25,
    material: 'metal',
    ore: 'metal',
    health: 75,
    maxHealth: 75,
    jaggedness: 0,
    rotation: 0,
    angularVelocity: 0,
    vertices: 4,
    offsets: [1, 1, 1, 1],
  };
}

function clearedHive(id: string): Extract<CooperativeRecord, { kind: 'hive' }> {
  const site = frontierSite(id);
  if (!site) {
    throw new Error('Site missing');
  }
  return {
    kind: 'hive',
    id: site.id,
    position: site.position,
    frontier: site.frontier,
    queenHealth: 0,
    birthFramesLeft: 480,
    clearedAt: 1,
    sacs: [0, 0],
    sacDeadline: null,
    sacsCompletedAt: 1,
    restoredValue: 0,
    contributors: [],
    commissionedAt: null,
  };
}

test('physical ore funds scanner once per consumed rock, preserves payouts and places overflow in supply stock', () => {
  const { engine, pilot, store } = scenario();
  const original = pilot.score;
  for (let i = 0; i < 34; i++) {
    const rock = ore(`ore-${i}`);
    engine.addAsteroid(rock);
    pilot.harpoonTargetId = rock.id;
    engine.processFurnaceDeliveries();
    engine.processFurnaceDeliveries();
  }
  expect(engine.getGameState().campaign?.projectValue).toBe(10_000);
  expect(pilot.score - original).toBe(10_200);
  engine.checkpointWorld();
  expect(store.load().cooperative?.records).toContainEqual({
    kind: 'supply',
    id: TOWN_HEARTH.id,
    availableValue: 200,
    nextShipment: 0,
  });
  pilot.position = { x: 0, y: 0 };
  expect(engine.crewAction(pilot.id, { kind: 'withdraw-supply' })).toBe(true);
  const supply = engine.getAsteroid(pilot.harpoonTargetId ?? '');
  expect(supply?.supply?.value).toBe(200);
  engine.checkpointWorld();
  expect(
    [...store.load().sectors.values()].flat().find((rock) => rock.id === supply?.id)?.supply
  ).toEqual({ sourceId: TOWN_HEARTH.id, value: 200 });
  pilot.position.x = -100;
  engine.abilities.advance();
  expect(supply?.velocity.x).toBeLessThan(0);

  expect(engine.crewAction(pilot.id, { kind: 'withdraw-supply' })).toBe(false);
  if (!supply) {
    throw new Error('Supply missing');
  }
  supply.position = { x: 0, y: 0 };
  engine.processFurnaceDeliveries();
  expect(engine.getAsteroid(supply.id)).toBeDefined();
  expect(engine.getGameState().campaign?.projectValue).toBe(10_000);
  expect(pilot.score - original).toBe(10_200);
});

test('inward physical supply commissions once, accounts overflow and restores every furnace service without replacing civic IDs', () => {
  const site = frontierSite('frontier:2,0');
  if (!site) {
    throw new Error('Site missing');
  }
  const hive: CooperativeRecord = {
    ...clearedHive(site.id),
    restoredValue: 9500,
    contributors: ['prior-builder'],
  };
  const { engine, pilot, store } = scenario([
    hive,
    { kind: 'supply', id: TOWN_HEARTH.id, availableValue: 500, nextShipment: 0 },
  ]);
  pilot.position = { x: 0, y: 0 };
  expect(engine.crewAction(pilot.id, { kind: 'withdraw-supply' })).toBe(true);
  const id = pilot.harpoonTargetId ?? '';
  const rock = engine.getAsteroid(id);
  if (!rock) {
    throw new Error('Supply missing');
  }
  expect(id).toBe(`supply:${TOWN_HEARTH.id}:0`);
  rock.surveyedBy = ['surveyor', pilot.id, 'prior-builder'];
  pilot.position = { ...site.position };
  engine.advanceOneFrame();
  const atlasCell = explorationCellAt({ x: site.position.x + 900, y: site.position.y });
  if (atlasCell === null) {
    throw new Error('Commissioning atlas cell is outside the world');
  }
  expect(isCellExplored(engine.getGameState().exploration ?? [], atlasCell)).toBe(false);
  rock.position = { ...site.position };
  rock.velocity = { x: 0, y: 0 };
  pilot.harpoonTargetId = id;
  engine.advanceOneFrame();
  expect(engine.getAsteroid(id)).toBeUndefined();
  engine.processFurnaceDeliveries();
  expect(engine.getAsteroid(id)).toBeUndefined();
  const state = engine.getGameState();
  expect(state.campaign?.commissioned).toEqual([site.id]);
  expect(isCellExplored(state.exploration ?? [], explorationCellAt(site.position) ?? -1)).toBe(
    true
  );
  expect(isCellExplored(state.exploration ?? [], atlasCell)).toBe(true);
  engine.checkpointWorld();
  const rows = store.load().cooperative?.records;
  expect(rows).toContainEqual(
    expect.objectContaining({
      kind: 'hive',
      restoredValue: COOPERATIVE.restoreValue,
      contributors: ['prior-builder', pilot.id, 'surveyor'],
      commissionedAt: 500_000,
    })
  );
  expect(rows).toContainEqual({
    kind: 'supply',
    id: site.id,
    availableValue: 400,
    nextShipment: 0,
  });
  expect(rows).toContainEqual({
    kind: 'supply',
    id: TOWN_HEARTH.id,
    availableValue: 0,
    nextShipment: 1,
  });
  const field = new FurnaceField();
  field.replaceFrontier(state.campaign?.commissioned ?? []);
  field.replaceLit(CIVIC_LOTS.map((lot) => ({ id: lot.id, builderName: 'Crew' })));
  expect(field.litModules()).toHaveLength(42);
  expect(field.intakeAt(site.position)?.id).toBe(site.id);
  expect(field.nearest(site.position).id).toBe(site.id);
  const localOre = ore('local-frontier-ore');
  localOre.position = { ...site.position };
  engine.addAsteroid(localOre);
  pilot.harpoonTargetId = localOre.id;
  const beforeLocalReward = pilot.score;
  engine.processFurnaceDeliveries();
  expect(engine.getAsteroid(localOre.id)).toBeUndefined();
  expect(pilot.score).toBe(beforeLocalReward + 300);
  engine.checkpointWorld();
  expect(store.load().cooperative?.records).toContainEqual({
    kind: 'supply',
    id: site.id,
    availableValue: 700,
    nextShipment: 0,
  });
  pilot.position = { ...site.position };
  expect(engine.furnaceTravel.start(pilot.id, TOWN_HEARTH.id)).toBeUndefined();
  expect(pilot.furnaceTransit).toMatchObject({ sourceId: site.id, destinationId: TOWN_HEARTH.id });
  expect(litTravelDestinations(TOWN_HEARTH.id, field).some((f) => f.id === site.id)).toBe(true);

  engine.stopGameLoop();
  const restarted = new GameEngine(
    82,
    new ServerClock({ wallNow: () => 500_001, monotonicNow: () => 0 }),
    new InlineWorldPersistence(store)
  );
  cleanups.push(() => restarted.stopGameLoop());
  expect(restarted.getGameState().campaign?.commissioned).toEqual([site.id]);
  expect(restarted.getGameState().mapAssets).toContainEqual({
    id: site.id,
    kind: 'furnace',
    name: site.name,
    position: site.position,
  });
  const returning = restarted.addPlayer(
    'returning',
    'Returning',
    new RecordingSocket(),
    { ...site.position },
    'hauler'
  );
  returning.haulerUtility = 'tow_cable';
  const resumedOre = ore('restarted-frontier-ore');
  resumedOre.position = { ...site.position };
  restarted.addAsteroid(resumedOre);
  returning.harpoonTargetId = resumedOre.id;
  restarted.processFurnaceDeliveries();
  expect(restarted.getAsteroid(resumedOre.id)).toBeUndefined();
  expect(returning.score).toBe(300);
  restarted.prepareDiagnosticWorld('traversal');
  expect(restarted.getGameState().campaign?.commissioned).toEqual([site.id]);
  expect(restarted.getGameState().mapAssets.some((asset) => asset.id === site.id)).toBe(true);
  restarted.resetForTesting();
  expect(restarted.getGameState().campaign).toBeUndefined();
  expect(restarted.getGameState().mapAssets.some((asset) => asset.id === site.id)).toBe(false);
  const freshPilot = restarted.addPlayer(
    'fresh',
    'Fresh',
    new RecordingSocket(),
    { ...site.position },
    'hauler'
  );
  freshPilot.haulerUtility = 'tow_cable';
  const resetOre = ore('reset-frontier-ore');
  resetOre.position = { ...site.position };
  restarted.addAsteroid(resetOre);
  freshPilot.harpoonTargetId = resetOre.id;
  restarted.processFurnaceDeliveries();
  expect(restarted.getAsteroid(resetOre.id)).toBeDefined();
  expect(freshPilot.score).toBe(0);
});

test('physical supply rejects dark, equal-radius, inward and same-site sources without consuming cargo', () => {
  const destination = clearedHive('frontier:3,0');
  const commissioned = ['frontier:0,3', 'frontier:3,1'].map((id) => ({
    ...clearedHive(id),
    restoredValue: COOPERATIVE.restoreValue,
    commissionedAt: 1,
  }));
  const { engine, pilot, store } = scenario([destination, ...commissioned]);
  pilot.position = { ...destination.position };
  engine.advanceOneFrame();
  const beforeScore = pilot.score;
  for (const [index, sourceId] of [
    destination.id,
    'frontier:0,3',
    'frontier:3,1',
    'frontier:2,0',
  ].entries()) {
    const rock = ore(`refused-supply-${index}`);
    rock.position = { ...destination.position };
    rock.ore = null;
    rock.supply = { sourceId, value: 100 };
    engine.addAsteroid(rock);
    pilot.harpoonTargetId = rock.id;
    engine.processFurnaceDeliveries();
    expect(engine.getAsteroid(rock.id)?.supply).toEqual({ sourceId, value: 100 });
    expect(pilot.harpoonTargetId).toBe(rock.id);
    expect(engine.drainFurnaceDeliveries()).toEqual([]);
  }
  expect(pilot.score).toBe(beforeScore);
  expect(engine.getGameState().campaign?.commissioned).toEqual(commissioned.map((h) => h.id));
  const valid = ore('outward-town-supply');
  valid.position = { ...destination.position };
  valid.ore = null;
  valid.supply = { sourceId: TOWN_HEARTH.id, value: 100 };
  engine.addAsteroid(valid);
  pilot.harpoonTargetId = valid.id;
  engine.processFurnaceDeliveries();
  expect(engine.getAsteroid(valid.id)).toBeUndefined();
  expect(pilot.score).toBe(beforeScore);
  engine.checkpointWorld();
  expect(store.load().cooperative?.records).toContainEqual({
    ...destination,
    restoredValue: 100,
    contributors: [pilot.id],
  });
});

test('a launched Tow Cable pins the queen and real swept laser contact damages her shielded body', () => {
  const { engine, pilot } = scenario();
  const site = frontierSite('frontier:2,0');
  if (!site) {
    throw new Error('Site missing');
  }
  pilot.position = { x: site.position.x + 150, y: site.position.y };
  pilot.angle = Math.PI;
  engine.advanceOneFrame();
  for (const rock of engine.getAllAsteroids()) {
    engine.removeAsteroid(rock.id);
  }
  engine.parkSatellitePickups();
  const before = engine.getGameState().campaign?.hives.find((h) => h.id === site.id);
  expect(before?.queenHealth).toBe(500);
  const shot = engine.spawnLaser(
    pilot.id,
    { x: site.position.x + 60, y: site.position.y },
    { x: -5, y: 0 }
  );
  if (!shot) {
    throw new Error('Shot missing');
  }
  engine.resolveSpawnedLaserHits(shot.id);
  expect(engine.getGameState().campaign?.hives.find((h) => h.id === site.id)?.queenHealth).toBe(
    500
  );
  expect(engine.useAbility(pilot.id)).toBe(true);
  resolveToolFlights(engine);
  expect(pilot.harpoonTargetId).toBe(site.id);
  engine.advanceOneFrame();
  expect(engine.getGameState().campaign?.hives.find((h) => h.id === site.id)?.shieldOpen).toBe(
    true
  );
  const exposed = engine.spawnLaser(
    pilot.id,
    { x: site.position.x + 60, y: site.position.y },
    { x: -5, y: 0 }
  );
  if (!exposed) {
    throw new Error('Shot missing');
  }
  engine.resolveSpawnedLaserHits(exposed.id);
  expect(engine.getGameState().campaign?.hives.find((h) => h.id === site.id)?.queenHealth).toBe(
    500 - DAMAGE.LASER_HIT
  );
});

test('actual hive state reaches only nearby snapshot recipients and carries shield and damage changes', () => {
  const { engine, pilot, socket } = scenario();
  const near = frontierSite('frontier:2,0'),
    far = frontierSite('frontier:-3,0');
  if (!near || !far) {
    throw new Error('Missing frontier sites');
  }
  pilot.position = { x: near.position.x + 150, y: near.position.y };
  pilot.angle = Math.PI;
  const remoteSocket = new RecordingSocket();
  const remote = engine.addPlayer(
    'remote',
    'Remote',
    remoteSocket,
    { x: far.position.x + 150, y: far.position.y },
    'scout'
  );
  engine.pilotSessions.register({ actor: remote, socket: remoteSocket });
  remote.position = { x: far.position.x + 150, y: far.position.y };
  engine.advanceOneFrame();
  for (const rock of engine.getAllAsteroids()) {
    engine.removeAsteroid(rock.id);
  }
  engine.parkSatellitePickups();
  expect(engine.getSnapshotState().campaign?.hives.map((hive) => hive.id)).toEqual(
    expect.arrayContaining([near.id, far.id])
  );
  const broadcaster = new GameStateBroadcaster(engine);
  broadcaster.negotiateSnapshot(socket);
  broadcaster.negotiateSnapshot(remoteSocket);
  const nearDecoder = new SnapshotDecoder('live'),
    farDecoder = new SnapshotDecoder('live');
  const hives = (recipient: RecordingSocket, decoder: SnapshotDecoder) => {
    const text = recipient.sent.filter((raw) => JSON.parse(raw).type === 'snapshot').at(-1);
    if (!text) {
      throw new Error('Missing broadcast snapshot');
    }
    return decodeSnapshotMessage(decoder, text).campaign?.hives;
  };
  broadcaster.broadcastGameState();
  expect(hives(socket, nearDecoder)).toEqual([
    expect.objectContaining({ id: near.id, queenHealth: 500, shieldOpen: false }),
  ]);
  expect(hives(remoteSocket, farDecoder)).toEqual([
    expect.objectContaining({ id: far.id, queenHealth: 500, shieldOpen: false }),
  ]);
  expect(engine.useAbility(pilot.id)).toBe(true);
  resolveToolFlights(engine);
  expect(pilot.harpoonTargetId).toBe(near.id);
  engine.advanceOneFrame();
  const shot = engine.spawnLaser(
    pilot.id,
    { x: near.position.x + 60, y: near.position.y },
    { x: -5, y: 0 }
  );
  if (!shot) {
    throw new Error('Missing shot');
  }
  engine.resolveSpawnedLaserHits(shot.id);
  broadcaster.broadcastGameState();
  expect(hives(socket, nearDecoder)).toEqual([
    expect.objectContaining({ id: near.id, queenHealth: 500 - DAMAGE.LASER_HIT, shieldOpen: true }),
  ]);
  expect(hives(remoteSocket, farDecoder)).toEqual([
    expect.objectContaining({ id: far.id, queenHealth: 500, shieldOpen: false }),
  ]);
});
