/* @vitest-environment node */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, test } from 'vitest';
import { decodeClientCommand } from '../../../server/communication/clientCommandDecoder';
import { MessageHandler } from '../../../server/communication/MessageHandler';
import { GameEngine } from '../../../server/core/GameEngine';
import { ServerClock } from '../../../server/core/ServerClock';
import { SERVER_RELEASE_ID } from '../../../server/release';
import { GameStateBroadcaster } from '../../../server/services/GameStateBroadcaster';
import { WorldStore } from '../../../server/world/WorldStore';
import { utcScoreSeason } from '../../../shared/world';
import { GAME, ROID } from '../../../src/constants';
import { RecordingSocket } from '../../support/recordingSocket';

const CLIENT_RELEASE = 'c'.repeat(40);
const PRIOR_RELEASE = 'a'.repeat(40);
const SCORE_RELEASE = 'b'.repeat(40);

const stores: WorldStore[] = [];
const temporaryDirectories: string[] = [];
const engines: GameEngine[] = [];

afterEach(() => {
  for (const engine of engines.splice(0)) {
    engine.stopGameLoop();
  }
  for (const store of stores.splice(0)) {
    store.close();
  }
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function worldStore(): WorldStore {
  const store = new WorldStore(':memory:');
  stores.push(store);
  return store;
}

function engineWithStore(store: WorldStore, clock?: ServerClock): GameEngine {
  const engine = new GameEngine(82, clock, store);
  engines.push(engine);
  return engine;
}

test('registering a pilot stamps the current server and joining client on the credential and starting score', () => {
  const store = worldStore();
  const engine = engineWithStore(store);
  const socket = new RecordingSocket();
  const actor = engine.addPlayer('scout', 'Bob', socket, { x: 200, y: 300 });
  actor.asteroidInteractions = 1;
  const registered = engine.registerPilot(actor, socket, CLIENT_RELEASE);
  assert(registered.ok);

  const saved = store.loadPilots().find((pilot) => pilot.id === 'scout');
  assert(saved);
  expect(saved).toMatchObject({
    score: GAME.STARTING_SCORE,
    credentialReleaseId: SERVER_RELEASE_ID,
    credentialClientReleaseId: CLIENT_RELEASE,
    scoreReleaseId: SERVER_RELEASE_ID,
    scoreClientReleaseId: CLIENT_RELEASE,
    lastClientReleaseId: CLIENT_RELEASE,
  });
  expect(store.loadWorld()?.writtenReleaseId).toBe(SERVER_RELEASE_ID);
});

test('a later score write updates score provenance without rotating the credential', () => {
  const store = worldStore();
  const engine = engineWithStore(store);
  const socket = new RecordingSocket();
  const actor = engine.addPlayer('miner', 'Miner', socket, { x: 0, y: 0 });
  actor.asteroidInteractions = 1;
  assert(engine.registerPilot(actor, socket, CLIENT_RELEASE).ok);
  actor.score = ROID.POINTS_LARGE;
  engine.checkpointWorld();

  const saved = store.loadPilots().find((pilot) => pilot.id === 'miner');
  assert(saved);
  expect(saved.score).toBe(ROID.POINTS_LARGE);
  expect(saved.credentialReleaseId).toBe(SERVER_RELEASE_ID);
  expect(saved.credentialClientReleaseId).toBe(CLIENT_RELEASE);
  expect(saved.scoreReleaseId).toBe(SERVER_RELEASE_ID);
  expect(saved.scoreClientReleaseId).toBe(CLIENT_RELEASE);
});

test('game over restamps score provenance and keeps the issued credential', () => {
  const store = worldStore();
  const engine = engineWithStore(store);
  const socket = new RecordingSocket();
  const actor = engine.addPlayer('pilot', 'Pilot', socket, { x: 400, y: 0 });
  actor.asteroidInteractions = 1;
  assert(engine.registerPilot(actor, socket, CLIENT_RELEASE).ok);
  actor.lives = 1;
  actor.score = 1200;
  actor.spawnProtectionTimer = 0;
  engine.checkpointWorld();
  expect(engine.handleShipDamage(actor.id, 'asteroid', actor.health).isDestroyed).toBe(true);

  const saved = store.loadPilots().find((pilot) => pilot.id === 'pilot');
  assert(saved);
  expect(saved.score).toBe(GAME.STARTING_SCORE);
  expect(saved.credentialReleaseId).toBe(SERVER_RELEASE_ID);
  expect(saved.credentialClientReleaseId).toBe(CLIENT_RELEASE);
  expect(saved.scoreReleaseId).toBe(SERVER_RELEASE_ID);
});

test('a UTC month boundary restamps scores and keeps the credential that issued the token', () => {
  let monotonicMs = 1_000;
  const clock = new ServerClock({
    wallNow: () => Date.parse('2026-09-30T12:00:00.000Z'),
    monotonicNow: () => monotonicMs,
  });
  const store = worldStore();
  const engine = engineWithStore(store, clock);
  const socket = new RecordingSocket();
  const actor = engine.addPlayer('pilot', 'Bob', socket, { x: 4_000, y: 1_200 });
  actor.asteroidInteractions = 1;
  assert(engine.registerPilot(actor, socket, CLIENT_RELEASE).ok);
  actor.score = 880;
  engine.checkpointWorld();
  monotonicMs += 24 * 60 * 60 * 1000;
  expect(utcScoreSeason(clock.now())).toBe('2026-10');
  actor.lastUpdate = clock.now();
  engine.advanceOneFrame();

  const saved = store.loadPilots().find((pilot) => pilot.id === 'pilot');
  assert(saved);
  expect(saved.score).toBe(0);
  expect(saved.credentialReleaseId).toBe(SERVER_RELEASE_ID);
  expect(saved.credentialClientReleaseId).toBe(CLIENT_RELEASE);
  expect(saved.scoreReleaseId).toBe(SERVER_RELEASE_ID);
  expect(store.loadWorld()?.writtenReleaseId).toBe(SERVER_RELEASE_ID);
});

test('legacy pilots without release stamps still load, and invalid stamps are dropped', () => {
  const directory = mkdtempSync(join(tmpdir(), 'georoids-release-'));
  temporaryDirectories.push(directory);
  const path = join(directory, 'world.sqlite');
  const initial = new WorldStore(path);
  initial.close();
  const db = new DatabaseSync(path);
  db.prepare('INSERT INTO pilots(id,json) VALUES(?,?)').run(
    'pilot',
    JSON.stringify({
      id: 'pilot',
      tokenHash: 'd'.repeat(64),
      name: 'Pilot',
      score: 42,
      credentialReleaseId: 'not-a-release',
      scoreReleaseId: SCORE_RELEASE,
      lastClientReleaseId: PRIOR_RELEASE,
    })
  );
  db.close();

  const store = new WorldStore(path);
  stores.push(store);
  expect(store.loadPilots()).toEqual([
    {
      id: 'pilot',
      tokenHash: 'd'.repeat(64),
      name: 'Pilot',
      score: 42,
      scoreReleaseId: SCORE_RELEASE,
      lastClientReleaseId: PRIOR_RELEASE,
    },
  ]);
});

test('joined echoes credential and score releases from the saved pilot', () => {
  const store = worldStore();
  const engine = engineWithStore(store);
  const broadcaster = new GameStateBroadcaster(engine);
  const handler = new MessageHandler(engine, broadcaster);
  const socket = new RecordingSocket();
  handler.handleMessage(
    {
      type: 'join',
      data: {
        id: 'scout',
        name: 'Bob',
        position: { x: 100, y: 100 },
        snapshotVersion: 1,
        asteroidInteractions: 1,
        clientReleaseId: CLIENT_RELEASE,
      },
    },
    socket
  );
  const joined = socket.lastReceived('joined');
  assert(joined);
  expect(joined.data).toMatchObject({
    id: 'scout',
    snapshotVersion: 1,
    serverReleaseId: SERVER_RELEASE_ID,
    credentialReleaseId: SERVER_RELEASE_ID,
    credentialClientReleaseId: CLIENT_RELEASE,
    scoreReleaseId: SERVER_RELEASE_ID,
    scoreClientReleaseId: CLIENT_RELEASE,
  });
  broadcaster.stopPeriodicBroadcast();
});

test('join decoding keeps a valid client release and ignores a malformed one', () => {
  const base = {
    type: 'join',
    data: {
      id: 'pilot',
      name: 'Pilot',
      position: { x: 12.5, y: -4 },
      snapshotVersion: 1,
      asteroidInteractions: 1,
    },
  };
  expect(
    decodeClientCommand({ ...base, data: { ...base.data, clientReleaseId: CLIENT_RELEASE } })
  ).toEqual({
    ok: true,
    command: {
      type: 'join',
      id: 'pilot',
      name: 'Pilot',
      position: { x: 12.5, y: -4 },
      snapshotVersion: 1,
      asteroidInteractions: 1,
      resumeRequested: false,
      clientReleaseId: CLIENT_RELEASE,
    },
  });
  expect(
    decodeClientCommand({ ...base, data: { ...base.data, clientReleaseId: 'short' } })
  ).toEqual({
    ok: true,
    command: {
      type: 'join',
      id: 'pilot',
      name: 'Pilot',
      position: { x: 12.5, y: -4 },
      snapshotVersion: 1,
      asteroidInteractions: 1,
      resumeRequested: false,
    },
  });
});
