import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { WebSocket } from 'ws';

import { GameEngine } from '../server/core/GameEngine';
import { ServerClock } from '../server/core/ServerClock';
import { GAME_TICK_MS } from '../shared/gameClock';
import type { Position, SatellitePickupData, ServerGameState } from '../shared-types';
import { ownBenchmarkIdentity } from './benchmark-identity';
import { createOwnedLoopback, type OwnedLoopback } from './owned-loopback';
import type { Measurement } from './results';

const SERVER_CLOCK_START_MS = 1_700_000_000_000;
const MAX_PLAYERS = 25;

type Diagnostics = ReturnType<GameEngine['getDiagnostics']>;

export interface ServerSampleOptions {
  readonly seed: number;
  readonly warmupTicks: number;
  readonly measuredTicks: number;
  readonly players: number;
}

export const DEFAULT_SERVER_SAMPLE_OPTIONS: ServerSampleOptions = {
  seed: 42,
  warmupTicks: 60,
  measuredTicks: 120,
  players: 2,
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
  requirePositiveInteger('players', options.players);
  if (options.players > MAX_PLAYERS) {
    throw new Error(`players must be no greater than ${MAX_PLAYERS}`);
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
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu,
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
  const observedIds = players
    .map((player) => player.id)
    .toSorted((left, right) => left.localeCompare(right));
  const expectedSorted = [...expectedIds].toSorted((left, right) => left.localeCompare(right));
  if (observedIds.length !== expectedSorted.length) {
    throw new Error(`Expected ${expectedSorted.length} players, observed ${observedIds.length}`);
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
    if (!player || player.id !== id) {
      throw new Error(`Participant ${id} is not attached to its live loopback peer`);
    }
  }
}

function validateDiagnostics(diagnostics: Diagnostics, players: number): void {
  if (diagnostics.isPaused) {
    throw new Error('Seeded server fixture is paused while players are present');
  }
  if (diagnostics.players !== players) {
    throw new Error(`Expected ${players} players, observed ${diagnostics.players}`);
  }
  if (diagnostics.asteroids < 0 || diagnostics.satellitePickups < 0) {
    throw new Error('Server diagnostics contained an invalid negative entity count');
  }
}

function validateStateScene(state: ServerGameState, diagnostics: Diagnostics): void {
  const playerEntities = state.entities.length;
  if (state.isPaused !== diagnostics.isPaused || state.gameTime !== diagnostics.gameTime) {
    throw new Error('Public game state disagreed with server diagnostics');
  }
  const counts = [
    ['players', playerEntities, diagnostics.players],
    ['asteroids', state.asteroids.length, diagnostics.asteroids],
    ['loot', state.loot.length, diagnostics.loot],
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

function validatePickupAccess(engine: GameEngine): SatellitePickupData {
  const detached = engine.getAllSatellitePickups()[0];
  if (!detached) {
    throw new Error('Seeded server fixture did not create a satellite pickup');
  }
  const viaGet = engine.getSatellitePickup(detached.id);
  if (!viaGet) {
    throw new Error(`Satellite pickup ${detached.id} is missing`);
  }
  const before = structuredClone(detached);
  const liveX = viaGet.position.x;
  detached.position.x += 1;
  viaGet.position.x += 1;
  const again = engine.getSatellitePickup(detached.id);
  if (!again || again.position.x !== liveX) {
    throw new Error('Satellite pickup accessors returned a live pickup position');
  }
  return before;
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
  const failures: Error[] = [];
  let loopback: OwnedLoopback | undefined;
  let engine: GameEngine | undefined;
  let identity: ReturnType<typeof ownBenchmarkIdentity> | undefined;
  let result: Measurement | undefined;
  try {
    identity = ownBenchmarkIdentity(options.seed);
    Date.now = () => clock.nowMs;
    Math.random = seededMathRandom(options.seed);
    loopback = await createOwnedLoopback();
    for (let index = 0; index < options.players; index++) {
      await loopback.connect();
    }
    loopback.assertHealthy();
    const peers = loopback.peers;

    engine = new GameEngine(
      options.seed,
      new ServerClock({
        wallNow: () => clock.nowMs,
        monotonicNow: () => clock.nowMs - SERVER_CLOCK_START_MS,
      })
    );
    // Match the production lifecycle: an empty engine first enters its paused
    // state, then the first public addPlayer call resumes and seeds the scene.
    engine.updatePauseState();
    const participantIds: string[] = [];
    for (let index = 0; index < options.players; index++) {
      const id = `benchmark-player-${index}`;
      const peer = peers[index];
      if (!peer) {
        throw new Error(`Missing accepted loopback peer for ${id}`);
      }
      engine.addPlayer(
        id,
        `Benchmark Pilot ${index}`,
        peer,
        participantPosition(index, options.players),
        'scout'
      );
      participantIds.push(id);
    }
    validateParticipantPresence(engine, peers, participantIds);
    const before = structuredClone(engine.getDiagnostics());
    validateDiagnostics(before, options.players);
    assert.equal(before.loot, 0, 'Server fixture must begin with no fabricated loot');
    const beforeState = stateSnapshot(engine);
    validateStateScene(beforeState, before);
    const pickupBefore = validatePickupAccess(engine);
    const pickupId = pickupBefore.id;

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
    assert.equal(
      engine.getServerTime(),
      Math.floor(clock.nowMs),
      'Server fixture must follow its controlled simulation clock'
    );
    const after = structuredClone(engine.getDiagnostics());
    validateDiagnostics(after, options.players);
    validateParticipantPresence(engine, peers, participantIds);
    const afterState = stateSnapshot(engine);
    validateStateScene(afterState, after);
    const livePickup = engine.getSatellitePickup(pickupId);
    if (!livePickup) {
      throw new Error(`Satellite pickup ${pickupId} disappeared during measurement`);
    }
    const pickupAfter = engine.getAllSatellitePickups().find((pickup) => pickup.id === pickupId);
    if (!pickupAfter) {
      throw new Error(`Detached satellite pickup ${pickupId} disappeared during measurement`);
    }
    const witness = outcomeWitness({
      before,
      after,
      beforeState,
      afterState,
      participantIds,
      pickup: { before: pickupBefore, after: pickupAfter },
    });
    result = {
      primaryMetric: 'advanceOneFrame-ms',
      samples: { 'advanceOneFrame-ms': measured },
      counts: {
        warmupTicks: options.warmupTicks,
        measuredTicks: options.measuredTicks,
        playersBefore: before.players,
        playersAfter: after.players,
        asteroidsBefore: before.asteroids,
        asteroidsAfter: after.asteroids,
        lootBefore: before.loot,
        lootAfter: after.loot,
        satellitePickupsBefore: before.satellitePickups,
        satellitePickupsAfter: after.satellitePickups,
      },
      witness,
      parameters: {
        ...options,
        identitySource: identity.source,
        initialLoot: 0,
        lootPolicy: 'Natural authoritative drops remain in the scene',
        clocks:
          'Seeded Math.random; controlled epoch and monotonic simulation clock; native timing clock',
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
      await loopback?.close();
    } catch (error) {
      failures.push(asError(error));
    }
    Date.now = originalDateNow;
    Math.random = originalMathRandom;
    try {
      identity?.release();
    } catch (error) {
      failures.push(asError(error));
    }
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
