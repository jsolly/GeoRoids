import assert from 'node:assert/strict';
import { once } from 'node:events';
import { performance } from 'node:perf_hooks';
import { WebSocket, WebSocketServer } from 'ws';

function isClosed(socket: WebSocket): boolean {
  return socket.readyState === WebSocket.CLOSED;
}

import { GameEngine } from '../server/core/GameEngine';
import { GAME_TICK_MS } from '../shared/gameClock';
import type { Position, SatelliteData, ServerGameState } from '../shared-types';
import type { Measurement } from './results';

const LOOPBACK_TIMEOUT_MS = 5_000;
const SOCKET_CLOSE_TIMEOUT_MS = 2_000;
const SERVER_CLOCK_START_MS = 1_700_000_000_000;
const MAX_HUMAN_PLAYERS = 25;

type Diagnostics = ReturnType<GameEngine['getDiagnostics']>;

export interface ServerSampleOptions {
  readonly seed: number;
  readonly warmupTicks: number;
  readonly measuredTicks: number;
  readonly humanPlayers: number;
}

export const DEFAULT_SERVER_SAMPLE_OPTIONS: ServerSampleOptions = {
  seed: 42,
  warmupTicks: 60,
  measuredTicks: 120,
  humanPlayers: 2,
};

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function requirePositiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
}

function validateOptions(options: ServerSampleOptions): void {
  if (!Number.isSafeInteger(options.seed)) {
    throw new Error('seed must be a safe integer');
  }
  requirePositiveInteger('warmupTicks', options.warmupTicks);
  requirePositiveInteger('measuredTicks', options.measuredTicks);
  requirePositiveInteger('humanPlayers', options.humanPlayers);
  if (options.humanPlayers > MAX_HUMAN_PLAYERS) {
    throw new Error(`humanPlayers must be no greater than ${MAX_HUMAN_PLAYERS}`);
  }
}

function participantPosition(index: number, count: number): Position {
  const angle = (index / count) * Math.PI * 2;
  return { x: Math.cos(angle) * 600, y: Math.sin(angle) * 600 };
}

/** A separate seeded stream for production paths that still call Math.random. */
function seededMathRandom(seed: number): () => number {
  let state = (seed >>> 0) ^ 0x6d2b79f5;
  return () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function stateSnapshot(engine: GameEngine): ServerGameState {
  return structuredClone(engine.getGameState());
}

/** Preserve JSON wire values and references; only opaque UUID substrings receive stable aliases. */
function outcomeWitness(value: object): object {
  const aliases = new Map<string, string>();
  const encoded = JSON.stringify(value, (_key: string, item: unknown) => {
    if (typeof item === 'number') {
      assert(Number.isFinite(item), 'Server outcome contains a non-finite number');
    }
    if (typeof item !== 'string') {
      return item;
    }
    return item.replace(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
      (uuid) => {
        const key = uuid.toLowerCase();
        const alias = aliases.get(key) ?? `runtime-id-${aliases.size + 1}`;
        aliases.set(key, alias);
        return alias;
      }
    );
  });
  const result: unknown = JSON.parse(encoded);
  assert(result && typeof result === 'object' && !Array.isArray(result));
  return result;
}

function validateParticipantPresence(
  engine: GameEngine,
  peers: readonly WebSocket[],
  expectedIds: readonly string[]
): void {
  const players = engine.getAllPlayers();
  const observedIds = players.map((player) => player.id).toSorted();
  const expectedSorted = [...expectedIds].toSorted();
  if (observedIds.length !== expectedSorted.length) {
    throw new Error(
      `Expected ${expectedSorted.length} human participants, observed ${observedIds.length}`
    );
  }
  for (const [index, id] of expectedSorted.entries()) {
    if (observedIds[index] !== id) {
      throw new Error(`Missing benchmark participant ${id}`);
    }
  }
  for (const [index, id] of expectedIds.entries()) {
    const peer = peers[index];
    if (!peer) {
      throw new Error(`Missing loopback peer for ${id}`);
    }
    if (peer.readyState !== WebSocket.OPEN) {
      throw new Error(`Loopback peer for ${id} is not open`);
    }
    const player = engine.getPlayerBySocket(peer);
    if (!player || player.id !== id || player.type !== 'human') {
      throw new Error(`Participant ${id} is not attached to its live loopback peer`);
    }
  }
}

function validateDiagnostics(
  diagnostics: Diagnostics,
  humanPlayers: number,
  expectedBots?: number
): void {
  if (diagnostics.isPaused) {
    throw new Error('Seeded server fixture is paused while human players are present');
  }
  if (diagnostics.humanPlayers !== humanPlayers) {
    throw new Error(`Expected ${humanPlayers} human players, observed ${diagnostics.humanPlayers}`);
  }
  if (diagnostics.bots <= 0) {
    throw new Error('Seeded server fixture did not create an active bot population');
  }
  if (expectedBots !== undefined && diagnostics.bots !== expectedBots) {
    throw new Error(
      `Expected ${expectedBots} bots after measurement, observed ${diagnostics.bots}`
    );
  }
  if (
    diagnostics.bots < 0 ||
    diagnostics.asteroids < 0 ||
    diagnostics.satellites < 0 ||
    diagnostics.satellitePickups < 0
  ) {
    throw new Error('Server diagnostics contained an invalid negative entity count');
  }
}

function validateStateScene(state: ServerGameState, diagnostics: Diagnostics): void {
  const humanEntities = state.entities.filter((entity) => entity.type === 'human').length;
  const botEntities = state.entities.filter((entity) => entity.type === 'bot').length;
  if (state.isPaused !== diagnostics.isPaused || state.gameTime !== diagnostics.gameTime) {
    throw new Error('Public game state disagreed with server diagnostics');
  }
  const counts = [
    ['human players', humanEntities, diagnostics.humanPlayers],
    ['bots', botEntities, diagnostics.bots],
    ['asteroids', state.asteroids.length, diagnostics.asteroids],
    ['loot', state.loot.length, diagnostics.loot],
    ['satellites', state.satellites.length, diagnostics.satellites],
    ['satellite pickups', state.satellitePickups.length, diagnostics.satellitePickups],
  ] as const;
  for (const [label, observed, expected] of counts) {
    if (observed !== expected) {
      throw new Error(
        `Public game state declared ${observed} ${label}, diagnostics declared ${expected}`
      );
    }
  }
}

function validateSatelliteAccess(engine: GameEngine): SatelliteData {
  const detached = engine.getAllSatellites()[0];
  if (!detached) {
    throw new Error('Seeded server fixture did not create a satellite');
  }
  const live = engine.getSatellite(detached.id);
  if (!live || engine.getSatellite(detached.id) !== live) {
    throw new Error(`Satellite ${detached.id} is not returned as a stable live actor`);
  }
  const before = structuredClone(detached);
  const liveX = live.position.x;
  detached.position.x += 1;
  if (live.position.x !== liveX) {
    throw new Error('getAllSatellites returned a live satellite position');
  }
  return before;
}

function isWebSocket(value: unknown): value is WebSocket {
  return value instanceof WebSocket;
}

async function closeSocket(socket: WebSocket, label: string): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) {
    return;
  }
  const closed = once(socket, 'close', { signal: AbortSignal.timeout(SOCKET_CLOSE_TIMEOUT_MS) });
  const results = await Promise.allSettled([
    closed,
    Promise.resolve().then(() => socket.close(1000, 'Benchmark cleanup')),
  ]);
  const failures = results
    .filter((result) => result.status === 'rejected')
    .map((result) => result.reason);
  if (failures.length && !isClosed(socket)) {
    const terminated = once(socket, 'close', {
      signal: AbortSignal.timeout(SOCKET_CLOSE_TIMEOUT_MS),
    });
    const forced = await Promise.allSettled([
      terminated,
      Promise.resolve().then(() => socket.terminate()),
    ]);
    for (const result of forced) {
      if (result.status === 'rejected') {
        failures.push(result.reason);
      }
    }
  }
  if (failures.length) {
    throw new AggregateError(failures, `${label} did not close normally`);
  }
}

async function closeListener(listener: WebSocketServer): Promise<void> {
  if (listener.address() === null) {
    return;
  }
  const closed = once(listener, 'close', { signal: AbortSignal.timeout(SOCKET_CLOSE_TIMEOUT_MS) });
  const failures: unknown[] = [];
  try {
    // Enter CLOSING synchronously so pending upgrades cannot add peers during teardown.
    listener.close();
  } catch (error) {
    failures.push(error);
  }
  const results = await Promise.allSettled([closed]);
  for (const result of results) {
    if (result.status === 'rejected') {
      failures.push(result.reason);
    }
  }
  if (failures.length) {
    throw new AggregateError(failures, 'Loopback listener did not close normally');
  }
}

async function closeOwnedSockets(
  listener: WebSocketServer | undefined,
  clients: readonly WebSocket[],
  peers: readonly WebSocket[]
): Promise<void> {
  const failures: Error[] = [];
  const listenerClosed = listener
    ? closeListener(listener).catch((error: unknown) => {
        failures.push(asError(error));
      })
    : Promise.resolve();
  const sockets = [...new Set([...clients, ...peers, ...(listener ? [...listener.clients] : [])])];
  const socketResults = await Promise.allSettled(
    sockets.map((socket, index) => closeSocket(socket, `loopback socket ${index}`))
  );
  for (const result of socketResults) {
    if (result.status === 'rejected') {
      failures.push(asError(result.reason));
    }
  }
  await listenerClosed;
  if (failures.length > 0) {
    throw new AggregateError(failures, 'Benchmark loopback cleanup failed');
  }
}

function advanceTick(engine: GameEngine, clock: { nowMs: number }): void {
  clock.nowMs += GAME_TICK_MS;
  engine.advanceOneFrame();
}

export async function runServerSample(
  options: ServerSampleOptions = DEFAULT_SERVER_SAMPLE_OPTIONS
): Promise<Measurement> {
  validateOptions(options);
  const originalDateNow = Date.now;
  const originalMathRandom = Math.random;
  const clock = { nowMs: SERVER_CLOCK_START_MS };
  const clients: WebSocket[] = [];
  const peers: WebSocket[] = [];
  const failures: Error[] = [];
  let listener: WebSocketServer | undefined;
  let engine: GameEngine | undefined;
  let result: Measurement | undefined;
  Date.now = () => clock.nowMs;
  Math.random = seededMathRandom(options.seed);
  try {
    listener = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    listener.on('error', (error) => failures.push(asError(error)));
    listener.on('connection', (peer) => {
      peers.push(peer);
      peer.on('error', (error) => failures.push(asError(error)));
    });
    await once(listener, 'listening', { signal: AbortSignal.timeout(LOOPBACK_TIMEOUT_MS) });
    const address = listener.address();
    if (!address || typeof address === 'string') {
      throw new Error('Loopback listener did not expose an address');
    }
    for (let index = 0; index < options.humanPlayers; index++) {
      const connection = once(listener, 'connection', {
        signal: AbortSignal.timeout(LOOPBACK_TIMEOUT_MS),
      });
      const client = new WebSocket(`ws://127.0.0.1:${address.port}`);
      clients.push(client);
      client.on('error', (error) => failures.push(asError(error)));
      const [peerValue] = await connection;
      if (!isWebSocket(peerValue)) {
        throw new Error(`Loopback connection ${index} did not provide a WebSocket peer`);
      }
      await once(client, 'open', { signal: AbortSignal.timeout(LOOPBACK_TIMEOUT_MS) });
    }
    if (failures.length > 0) {
      throw failures[0];
    }

    engine = new GameEngine(options.seed);
    // Match the production lifecycle: an empty engine first enters its paused
    // state, then the first public addPlayer call resumes and seeds the scene.
    engine.updatePauseState();
    const participantIds: string[] = [];
    for (let index = 0; index < options.humanPlayers; index++) {
      const id = `benchmark-human-${index}`;
      const peer = peers[index];
      if (!peer) {
        throw new Error(`Missing accepted loopback peer for ${id}`);
      }
      engine.addPlayer(
        id,
        `Benchmark Pilot ${index}`,
        peer,
        participantPosition(index, options.humanPlayers),
        '#89aaff',
        'dart',
        index % 2 === 0 ? 'ion' : 'ember'
      );
      participantIds.push(id);
    }
    validateParticipantPresence(engine, peers, participantIds);
    const before = structuredClone(engine.getDiagnostics());
    validateDiagnostics(before, options.humanPlayers);
    assert.equal(before.loot, 0, 'Server fixture must begin with no fabricated loot');
    const beforeState = stateSnapshot(engine);
    validateStateScene(beforeState, before);
    const satelliteBefore = validateSatelliteAccess(engine);
    const satelliteId = satelliteBefore.id;

    for (let index = 0; index < options.warmupTicks; index++) {
      advanceTick(engine, clock);
    }
    const measured: number[] = [];
    for (let index = 0; index < options.measuredTicks; index++) {
      clock.nowMs += GAME_TICK_MS;
      const startedAt = performance.now();
      engine.advanceOneFrame();
      measured.push(performance.now() - startedAt);
    }
    if (failures.length > 0) {
      throw failures[0];
    }
    const after = structuredClone(engine.getDiagnostics());
    validateDiagnostics(after, options.humanPlayers, before.bots);
    validateParticipantPresence(engine, peers, participantIds);
    const afterState = stateSnapshot(engine);
    validateStateScene(afterState, after);
    const liveSatellite = engine.getSatellite(satelliteId);
    if (!liveSatellite) {
      throw new Error(`Satellite ${satelliteId} disappeared during measurement`);
    }
    const satelliteAfter = engine
      .getAllSatellites()
      .find((satellite) => satellite.id === satelliteId);
    if (!satelliteAfter) {
      throw new Error(`Detached satellite ${satelliteId} disappeared during measurement`);
    }
    const witness = outcomeWitness({
      before,
      after,
      beforeState,
      afterState,
      participantIds,
      satellite: { before: satelliteBefore, after: satelliteAfter },
    });
    result = {
      primaryMetric: 'advanceOneFrame-ms',
      samples: { 'advanceOneFrame-ms': measured },
      counts: {
        warmupTicks: options.warmupTicks,
        measuredTicks: options.measuredTicks,
        humanPlayersBefore: before.humanPlayers,
        humanPlayersAfter: after.humanPlayers,
        botsBefore: before.bots,
        botsAfter: after.bots,
        asteroidsBefore: before.asteroids,
        asteroidsAfter: after.asteroids,
        lootBefore: before.loot,
        lootAfter: after.loot,
        satellitesBefore: before.satellites,
        satellitesAfter: after.satellites,
        satellitePickupsBefore: before.satellitePickups,
        satellitePickupsAfter: after.satellitePickups,
      },
      witness,
      parameters: {
        ...options,
        initialLoot: 0,
        lootPolicy: 'Natural authoritative drops remain in the scene',
        clocks: 'Seeded Math.random and fixed Date.now; native performance.now',
      },
      cleanup: 'complete',
    };
  } catch (error) {
    failures.push(asError(error));
  } finally {
    try {
      engine?.stopGameLoop();
    } catch (error) {
      failures.push(asError(error));
    }
    try {
      await closeOwnedSockets(listener, clients, peers);
    } catch (error) {
      failures.push(asError(error));
    }
    Date.now = originalDateNow;
    Math.random = originalMathRandom;
  }
  // Include transport errors delivered during teardown as failed measurements.
  if (failures.length) {
    throw new AggregateError([...new Set(failures)], 'Server measurement or cleanup failed');
  }
  if (!result) {
    throw new Error('Server benchmark completed without a result');
  }
  return result;
}
