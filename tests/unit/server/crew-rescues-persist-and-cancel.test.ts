/* @vitest-environment node */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, test, vi } from 'vitest';
import { MessageHandler } from '../../../server/communication/MessageHandler';
import { GameEngine } from '../../../server/core/GameEngine';
import { ServerClock } from '../../../server/core/ServerClock';
import { GameStateBroadcaster } from '../../../server/services/GameStateBroadcaster';
import {
  legacyWorldDigest,
  migrateCooperativeWorld,
} from '../../../server/world/cooperativeSchema';
import { InlineWorldPersistence } from '../../../server/world/InlineWorldPersistence';
import { WorldStore } from '../../../server/world/WorldStore';
import { RecordingSocket } from '../../support/recordingSocket';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    cleanup();
  }
});
function scenario() {
  const dir = mkdtempSync(join(tmpdir(), 'crew-rescue-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'world.sqlite');
  new WorldStore(path).close();
  const db = new DatabaseSync(path);
  migrateCooperativeWorld(db, legacyWorldDigest(db));
  db.exec('UPDATE cooperative_schema SET activated=1');
  db.close();
  let elapsed = 0;
  const clock = new ServerClock({ wallNow: () => 100_000, monotonicNow: () => elapsed });
  const store = new WorldStore(path);
  cleanups.push(() => store.close());
  const engine = new GameEngine(82, clock, new InlineWorldPersistence(store));
  cleanups.push(() => engine.stopGameLoop());
  const socket = new RecordingSocket();
  const downed = engine.addPlayer('downed', 'Downed', socket, { x: 2200, y: 2200 }, 'hauler');
  const joined = engine.pilotSessions.register({ actor: downed, socket: socket });
  if (!joined.ok) {
    throw new Error('Fixture registration failed');
  }
  const rescuerSocket = new RecordingSocket();
  const rescuer = engine.addPlayer(
    'rescuer',
    'Rescuer',
    rescuerSocket,
    { x: 2300, y: 2200 },
    'scout'
  );
  engine.pilotSessions.register({ actor: rescuer, socket: rescuerSocket });
  downed.position = { x: 2200, y: 2200 };
  rescuer.position = { x: 2300, y: 2200 };
  downed.spawnProtectionTimer = 0;
  rescuer.spawnProtectionTimer = 0;
  engine.handleShipDamage(downed.id, 'asteroid', 1000);
  const tick = (ms: number) => {
    elapsed = ms;
    engine.advanceCombatFrame();
  };
  return {
    engine,
    downed,
    rescuer,
    rescuerSocket,
    socket,
    clock,
    setElapsed: (ms: number) => {
      elapsed = ms;
    },
    tick,
    store,
    token: joined.resumeToken,
  };
}

test('a different live pilot revives at 100 units after three seconds to 35% hull', () => {
  const { engine, downed, rescuer, tick } = scenario();
  expect(downed.downedUntil).toBe(130_000);
  expect(downed.exploding).toBe(false);
  downed.equipment = ['resource_tap'];
  expect(engine.setHaulerUtility(downed.id, 'resource_tap')).toBe(false);
  expect(downed.haulerUtility).not.toBe('resource_tap');
  expect(engine.crewAction(downed.id, { kind: 'revive', targetId: downed.id })).toBe(false);
  rescuer.position.x = 2300.01;
  expect(engine.crewAction(rescuer.id, { kind: 'revive', targetId: downed.id })).toBe(false);
  rescuer.position.x = 2300;
  expect(engine.crewAction(rescuer.id, { kind: 'revive', targetId: downed.id })).toBe(true);
  tick(2999);
  expect(downed.health).toBe(0);
  tick(3000);
  expect(downed.health).toBe(downed.maxHealth * 0.35);
  expect(downed.downedUntil).toBeNull();
  expect(downed.spawnProtectionTimer).toBeGreaterThan(0);
  expect(rescuer.rescue).toBeNull();
});

test.each(['release', 'movement', 'overlay', 'damage', 'disconnect'] as const)(
  '%s cancels an active rescue',
  (cause) => {
    const { engine, downed, rescuer, rescuerSocket, tick } = scenario();
    engine.crewAction(rescuer.id, { kind: 'revive', targetId: downed.id });
    switch (cause) {
      case 'release':
        engine.crewAction(rescuer.id, { kind: 'release' });
        break;
      case 'movement':
        engine.crewRescue.cancelOnMovement(rescuer.id, { x: 2301, y: 2200 });
        break;
      case 'overlay':
        engine.setOverlayHold(rescuer.id, true);
        break;
      case 'damage':
        engine.handleShipDamage(rescuer.id, 'asteroid', 1);
        break;
      case 'disconnect':
        engine.transportClosed(rescuerSocket);
        break;
      default: {
        const unhandled: never = cause;
        throw new Error(unhandled);
      }
    }
    expect(rescuer.rescue).toBeNull();
    tick(3000);
    expect(downed.health).toBe(0);
    expect(rescuer.rescue).toBeNull();
  }
);

test('downed deadlines persist and giving up cannot finalize the same death twice', () => {
  const { engine, downed, tick, store } = scenario();
  downed.cargo = 250;
  engine.checkpointWorld();
  expect(store.load().cooperative?.records).toContainEqual({
    kind: 'downed',
    id: downed.id,
    position: downed.position,
    deadline: 130_000,
    cause: 'asteroid',
  });
  expect(engine.crewAction(downed.id, { kind: 'give-up' })).toBe(true);
  expect(engine.crewAction(downed.id, { kind: 'give-up' })).toBe(false);
  expect(downed.cargo).toBe(0);
  const timer = downed.respawnTimer;
  tick(30_000);
  expect(downed.respawnTimer).toBeLessThan(timer ?? 0);
  engine.checkpointWorld();
  expect(store.load().cooperative?.records).toEqual([]);
});

test('signals are bounded to one per pilot, nearby coordinates and a two-second placement interval', () => {
  const { engine, rescuer, tick } = scenario();
  const signal = { kind: 'signal', signal: 'help', position: { x: 2500, y: 2200 } } as const;
  expect(engine.crewAction(rescuer.id, signal)).toBe(true);
  expect(engine.crewAction(rescuer.id, signal)).toBe(false);
  tick(2000);
  expect(engine.crewAction(rescuer.id, { ...signal, position: { x: 50_000, y: 0 } })).toBe(false);
  expect(engine.crewAction(rescuer.id, signal)).toBe(true);
  tick(32_000);
  expect(rescuer.crewSignal).toBeNull();
});

test('owned crew commands reject an impostor and rescue disconnects at either end', () => {
  const { engine, downed, rescuer, rescuerSocket, socket, tick } = scenario();
  const handler = new MessageHandler(engine, new GameStateBroadcaster(engine));
  const message = {
    type: 'crewAction',
    id: rescuer.id,
    data: { kind: 'revive', targetId: downed.id },
  };
  handler.handleMessage(message, new RecordingSocket());
  expect(rescuer.rescue).toBeUndefined();
  handler.handleMessage(message, rescuerSocket);
  expect(rescuer.rescue?.targetId).toBe(downed.id);
  engine.transportClosed(socket);
  tick(3000);
  expect(rescuer.rescue).toBeNull();
  expect(downed.health).toBe(0);
});

test('an activated campaign refuses unsupported clients before creating a pilot', () => {
  const { engine } = scenario();
  const handler = new MessageHandler(engine, new GameStateBroadcaster(engine));
  const socket = new RecordingSocket();
  const data = {
    name: 'Newcomer',
    position: { x: 0, y: 0 },
    kitId: 'scout',
    snapshotVersion: 3,
    asteroidInteractions: 1,
    explorationVersion: 1,
  };
  handler.handleMessage({ type: 'join', id: 'newcomer', data }, socket);
  expect(engine.getPlayerBySocket(socket)).toBeUndefined();
  expect(socket.lastReceived('error')?.data).toBe(
    'Refresh this client to join the cooperative campaign'
  );
  handler.handleMessage(
    { type: 'join', id: 'newcomer', data: { ...data, cooperativeVersion: 1 } },
    socket
  );
  expect(engine.getPlayerBySocket(socket)?.id).toBe('newcomer');
  expect(socket.received('joined')).toHaveLength(1);
});

test('restart before the deadline restores cargo and kit, then connected bleed-out finalizes once', () => {
  const { engine, downed, store, token, clock, tick } = scenario();
  downed.cargo = 250;
  engine.checkpointWorld();
  engine.stopGameLoop();
  const restarted = new GameEngine(82, clock, new InlineWorldPersistence(store));
  cleanups.push(() => restarted.stopGameLoop());
  const resumed = restarted.pilotSessions.resume({
    token: token,
    socket: new RecordingSocket(),
    requestedKit: 'scout',
  });
  if (!resumed.ok) {
    throw new Error(resumed.error);
  }
  expect(resumed.actor).toMatchObject({
    downedUntil: 130_000,
    health: 0,
    cargo: 250,
    kitId: 'hauler',
  });
  tick(30_000);
  restarted.advanceCombatFrame();
  expect(resumed.actor.downedUntil).toBeNull();
  expect(resumed.actor.cargo).toBe(0);
  const timer = resumed.actor.respawnTimer;
  restarted.advanceCombatFrame();
  expect(resumed.actor.respawnTimer).toBe((timer ?? 0) - 1);
  restarted.checkpointWorld();
  expect(store.load().cooperative?.records.some((row) => row.kind === 'downed')).toBe(false);
});

test('simultaneous rescuers complete one revival and retire both holds', () => {
  const { engine, downed, rescuer, tick } = scenario();
  const other = engine.addPlayer(
    'other',
    'Other',
    new RecordingSocket(),
    { x: 2250, y: 2200 },
    'scout'
  );
  other.position = { x: 2250, y: 2200 };
  engine.crewAction(rescuer.id, { kind: 'revive', targetId: downed.id });
  engine.crewAction(other.id, { kind: 'revive', targetId: downed.id });
  const epoch = downed.playerMotion?.epoch;
  tick(3000);
  expect(downed.health).toBe(downed.maxHealth * 0.35);
  expect(downed.playerMotion?.epoch).toBe((epoch ?? 0) + 1);
  expect(rescuer.rescue).toBeNull();
  expect(other.rescue).toBeNull();
});

test('bleed-out wins when a revive would complete exactly at the downed deadline', () => {
  const { engine, downed, rescuer, tick } = scenario();
  downed.cargo = 100;
  tick(27_000);
  expect(engine.crewAction(rescuer.id, { kind: 'revive', targetId: downed.id })).toBe(true);
  tick(30_000);
  expect(downed.downedUntil).toBeNull();
  expect(downed.health).toBe(0);
  expect(downed.cargo).toBe(0);
  expect(downed.respawnTimer).toBeGreaterThan(0);
  expect(rescuer.rescue).toBeNull();
});

test('bleed-out remains connected through the real frame stale-pilot sweep and respawns', () => {
  const { engine, downed, setElapsed } = scenario();
  // A downed browser sends no movement poses for the full thirty-second rescue window.
  for (const rock of engine.getAllAsteroids()) {
    engine.removeAsteroid(rock.id);
  }
  engine.createAsteroids(0);
  setElapsed(30_001);
  engine.advanceOneFrame();
  expect(engine.getPlayer(downed.id)).toBe(downed);
  expect(downed.downedUntil).toBeNull();
  for (let frame = 0; frame < 300; frame++) {
    engine.advanceOneFrame();
  }
  expect(engine.getPlayer(downed.id)).toBe(downed);
  expect(downed.health).toBe(downed.maxHealth);
  expect(downed.respawnTimer).toBeUndefined();
});

test('a saved downed pilot expiring offline finalizes on resume and stays finalized after another restart', () => {
  const { engine, downed, store, token, clock, setElapsed } = scenario();
  downed.cargo = 250;
  engine.checkpointWorld();
  engine.stopGameLoop();
  setElapsed(30_001);
  const restarted = new GameEngine(82, clock, new InlineWorldPersistence(store));
  cleanups.push(() => restarted.stopGameLoop());
  const schedule = vi.spyOn(restarted.entityManager, 'scheduleShipRespawn');
  const resumed = restarted.pilotSessions.resume({
    token: token,
    socket: new RecordingSocket(),
    requestedKit: 'scout',
  });
  if (!resumed.ok) {
    throw new Error(resumed.error);
  }
  expect(resumed.actor).toMatchObject({
    health: 0,
    downedUntil: null,
    cargo: 0,
    kitId: 'hauler',
    exploding: true,
  });
  expect(resumed.actor.respawnTimer).toBeGreaterThan(0);
  expect(schedule).toHaveBeenCalledTimes(1);
  const timer = resumed.actor.respawnTimer;
  restarted.advanceCombatFrame();
  expect(resumed.actor.respawnTimer).toBe((timer ?? 0) - 1);
  expect(schedule).toHaveBeenCalledTimes(1);
  restarted.checkpointWorld();
  expect(store.load().cooperative?.records.some((row) => row.kind === 'downed')).toBe(false);
  restarted.stopGameLoop();
  const again = new GameEngine(82, clock, new InlineWorldPersistence(store));
  cleanups.push(() => again.stopGameLoop());
  const restored = again.pilotSessions.resume({
    token: resumed.resumeToken,
    socket: new RecordingSocket(),
  });
  if (!restored.ok) {
    throw new Error(restored.error);
  }
  expect(restored.actor.downedUntil).toBeUndefined();
  expect(restored.actor.cargo).toBe(0);
  expect(
    again.getSnapshotState().mapAssets.filter((asset) => asset.kind === 'ship-remains')
  ).toEqual([]);
  again.checkpointWorld();
  expect(store.load().cooperative?.records.some((row) => row.kind === 'downed')).toBe(false);
});

test('the full always frame completes a stationary rescue without a combat-only step', () => {
  const { engine, downed, rescuer, setElapsed, store } = scenario();
  expect(engine.crewAction(rescuer.id, { kind: 'revive', targetId: downed.id })).toBe(true);
  const completion = rescuer.rescue?.completesAt;
  setElapsed(1000);
  expect(engine.crewAction(rescuer.id, { kind: 'revive', targetId: downed.id })).toBe(true);
  expect(rescuer.rescue?.completesAt).toBe(completion);
  setElapsed(3000);
  engine.advanceOneFrame();
  expect(downed.health).toBe(downed.maxHealth * 0.35);
  expect(downed.downedUntil).toBeNull();
  expect(rescuer.rescue).toBeNull();
  engine.checkpointWorld();
  expect(store.load().cooperative?.records.some((row) => row.kind === 'downed')).toBe(false);
});

test('diagnostic rearrangement preserves signal cooldown while removal retires its identity', () => {
  const { engine, rescuer, rescuerSocket } = scenario();
  const signal = { kind: 'signal', signal: 'help', position: { ...rescuer.position } } as const;
  expect(engine.crewAction(rescuer.id, signal)).toBe(true);
  engine.prepareDiagnosticWorld('traversal');
  expect(engine.crewAction(rescuer.id, signal)).toBe(false);
  const position = { ...rescuer.position };
  engine.removePlayer(rescuer.id);
  const rejoined = engine.addPlayer(rescuer.id, 'Rescuer', rescuerSocket, position, 'scout');
  expect(engine.crewAction(rejoined.id, { ...signal, position: { ...rejoined.position } })).toBe(
    true
  );
  engine.resetForTesting();
  expect(engine.getAllPlayers()).toEqual([]);
  expect(engine.cooperativeEnabled()).toBe(false);
});

test('sub-threshold movement preserves the hold and a turn beyond the existing threshold cancels it', () => {
  const { engine, downed, rescuer, tick } = scenario();
  expect(engine.crewAction(rescuer.id, { kind: 'revive', targetId: downed.id })).toBe(true);
  const completion = rescuer.rescue?.completesAt;
  engine.crewRescue.cancelOnMovement(
    rescuer.id,
    { x: rescuer.position.x + 0.5, y: rescuer.position.y },
    { x: 0.01, y: 0 },
    rescuer.angle
  );
  expect(rescuer.rescue?.completesAt).toBe(completion);
  engine.crewRescue.cancelOnMovement(rescuer.id, undefined, undefined, rescuer.angle + 0.02);
  tick(3000);
  expect(downed.health).toBe(0);
  expect(rescuer.rescue).toBeNull();
});

test('an expired downed live session finalizes on socket takeover without waiting for a frame', () => {
  const { engine, downed, token, setElapsed, store } = scenario();
  downed.cargo = 250;
  setElapsed(30_001);
  const resumed = engine.pilotSessions.resume({ token: token, socket: new RecordingSocket() });
  if (!resumed.ok) {
    throw new Error(resumed.error);
  }
  expect(resumed.actor).toBe(downed);
  expect(downed).toMatchObject({ health: 0, downedUntil: null, cargo: 0, kitId: 'hauler' });
  expect(downed.respawnTimer).toBeGreaterThan(0);
  const timer = downed.respawnTimer;
  const again = engine.pilotSessions.resume({
    token: resumed.resumeToken,
    socket: new RecordingSocket(),
  });
  expect(again.ok).toBe(true);
  expect(downed.respawnTimer).toBe(timer);
  engine.checkpointWorld();
  expect(store.load().cooperative?.records.some((row) => row.kind === 'downed')).toBe(false);
});
