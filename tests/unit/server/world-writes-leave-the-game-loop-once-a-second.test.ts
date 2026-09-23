/* @vitest-environment node */
import assert from 'node:assert/strict';
import { afterEach, expect, test, vi } from 'vitest';
import { GameEngine } from '../../../server/core/GameEngine';
import { ServerClock } from '../../../server/core/ServerClock';
import { InlineWorldPersistence } from '../../../server/world/InlineWorldPersistence';
import { WorldStore } from '../../../server/world/WorldStore';
import type {
  LoadedWorld,
  WorldCheckpoint,
  WorldPersistence,
  WorldPersistenceDiagnostics,
} from '../../../server/world/worldPersistence';
import type { AsteroidData } from '../../../shared-types';
import { GAME, ROID } from '../../../src/constants';
import { RecordingSocket } from '../../support/recordingSocket';

const WALL_ORIGIN_MS = 10_000;

const cleanups: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) {
    cleanup();
  }
});

function metalDeposit(id: string, position = { x: 400, y: 300 }): AsteroidData {
  return {
    id,
    position,
    velocity: { x: 0, y: 0 },
    size: 25,
    material: 'metal',
    health: 75,
    maxHealth: 75,
    jaggedness: 0.5,
    rotation: 0,
    angularVelocity: 0,
    vertices: 8,
    offsets: [1, 1, 1, 1, 1, 1, 1, 1],
  };
}

function world(persistence: WorldPersistence) {
  let elapsed = 0;
  const clock = new ServerClock({ wallNow: () => WALL_ORIGIN_MS, monotonicNow: () => elapsed });
  const engine = new GameEngine(82, clock, persistence);
  cleanups.push(() => engine.stopGameLoop());
  const socket = new RecordingSocket();
  const miner = engine.addPlayer('miner', 'Miner', socket, { x: 0, y: 0 }, 'hauler');
  miner.asteroidInteractions = 1;
  assert(engine.registerPilot(miner, socket).ok);
  for (const rock of engine.getAllAsteroids()) {
    engine.removeAsteroid(rock.id);
  }
  const frame = () => {
    elapsed += 1000 / GAME.FPS;
    engine.advanceOneFrame(clock.now());
  };
  return { engine, miner, frame };
}

test('a mining break and its score reach the database on the next one-second flush, not on the tick', () => {
  const store = new WorldStore(':memory:');
  cleanups.push(() => store.close());
  const commits = vi.spyOn(WorldStore.prototype, 'checkpoint');
  const { engine, miner, frame } = world(new InlineWorldPersistence(store));
  const target = metalDeposit('flush-target');
  engine.addAsteroid(target);
  // Storage starts out holding the intact deposit and a score of zero.
  engine.checkpointWorld();
  expect(store.loadSector('0,0')?.some((rock) => rock.id === target.id)).toBe(true);
  commits.mockClear();

  expect(engine.handleAsteroidHit(target.id, miner.id, 'laser').outcome).toBe('tagged');
  expect(engine.handleAsteroidHit(target.id, miner.id, 'laser').outcome).toBe('destroyed');
  expect(miner.score).toBe(ROID.POINTS_MEDIUM);
  // The break is a terminal, score-bearing event, yet nothing touches storage yet.
  expect(commits).not.toHaveBeenCalled();
  expect(store.loadSector('0,0')?.some((rock) => rock.id === target.id)).toBe(true);

  for (let tick = 1; tick < GAME.FPS; tick++) {
    frame();
  }
  expect(commits).not.toHaveBeenCalled();
  frame();
  expect(commits).toHaveBeenCalledTimes(1);
  expect(store.loadSector('0,0')?.some((rock) => rock.id === target.id)).toBe(false);
  expect(miner.score).toBeGreaterThanOrEqual(ROID.POINTS_MEDIUM);
  expect(store.loadPilots().find((pilot) => pilot.id === miner.id)?.score).toBe(miner.score);

  // Another second of ordinary flight is one more batch, and the last
  // pilot's departure flushes at once so a pause leaves nothing pending.
  for (let tick = 0; tick < GAME.FPS; tick++) {
    frame();
  }
  expect(commits).toHaveBeenCalledTimes(2);
  miner.score = 999;
  engine.removePlayer(miner.id);
  expect(engine.getDiagnostics().isPaused).toBe(true);
  expect(commits).toHaveBeenCalledTimes(3);
  expect(store.loadPilots().find((pilot) => pilot.id === miner.id)?.score).toBe(999);
});

/** A writer whose commits finish only when the test says so. */
class InFlightPersistence implements WorldPersistence {
  readonly batches: WorldCheckpoint[] = [];
  pendingBatches = 0;
  shutdownCalls = 0;
  /** When set, the next hand-over throws this instead of accepting the batch. */
  rejectNextBatchWith: Error | undefined;
  private readonly idleWaiters: Array<() => void> = [];
  load(): LoadedWorld {
    return { world: undefined, sectors: new Map(), pilots: [] };
  }
  persist(batch: WorldCheckpoint): void {
    if (this.rejectNextBatchWith) {
      const error = this.rejectNextBatchWith;
      this.rejectNextBatchWith = undefined;
      throw error;
    }
    this.batches.push(batch);
  }
  reset(): void {}
  onFailure(): void {}
  whenIdle(): Promise<void> {
    if (this.pendingBatches === 0) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.idleWaiters.push(resolve);
    });
  }
  drain(): void {
    this.pendingBatches = 0;
    for (const resolve of this.idleWaiters.splice(0)) {
      resolve();
    }
  }
  shutdown(): Promise<void> {
    this.shutdownCalls++;
    return Promise.resolve();
  }
  diagnostics(): WorldPersistenceDiagnostics {
    return {
      mode: 'worker',
      pendingBatches: this.pendingBatches,
      committedBatches: 0,
      failed: false,
    };
  }
}

test('a commit still in flight defers the next flush, which then carries everything that changed meanwhile', async () => {
  const persistence = new InFlightPersistence();
  const { engine, miner, frame } = world(persistence);
  const target = metalDeposit('deferred-target', { x: 40, y: 0 });
  engine.addAsteroid(target);
  expect(persistence.batches).toHaveLength(0);
  for (let tick = 0; tick < GAME.FPS; tick++) {
    frame();
  }
  expect(persistence.batches).toHaveLength(1);
  // The first flush carries the world row with the pilot's discoveries.
  expect(persistence.batches[0]?.world?.exploration.length).toBeGreaterThan(0);
  expect(persistence.batches[0]?.sectors.get('0,0')?.map((rock) => rock.id)).toEqual([target.id]);

  // The worker is still committing: this second's cadence passes without a
  // new batch, even though a deposit breaks and a score changes meanwhile.
  persistence.pendingBatches = 1;
  expect(engine.handleAsteroidHit(target.id, miner.id, 'laser').outcome).toBe('tagged');
  expect(engine.handleAsteroidHit(target.id, miner.id, 'laser').outcome).toBe('destroyed');
  expect(miner.score).toBeGreaterThanOrEqual(ROID.POINTS_MEDIUM);
  for (let tick = 0; tick < GAME.FPS; tick++) {
    frame();
  }
  expect(persistence.batches).toHaveLength(1);

  // Explicit flushes coalesce too: the last pilot leaving and a repeated
  // request add nothing while the writer is busy...
  engine.removePlayer(miner.id);
  expect(engine.getDiagnostics().isPaused).toBe(true);
  engine.checkpointWorld();
  expect(persistence.batches).toHaveLength(1);

  // ...and exactly one flush follows as soon as the writer is idle again,
  // carrying the emptied sector and the score from the deferred window. The
  // world row stays home: nothing in it changed since the first flush.
  persistence.drain();
  await Promise.resolve();
  expect(persistence.batches).toHaveLength(2);
  const deferred = persistence.batches[1];
  assert(deferred);
  expect(deferred.sectors.get('0,0')).toEqual([]);
  expect(deferred.pilots.map((pilot) => [pilot.id, pilot.score])).toEqual([
    [miner.id, miner.score],
  ]);
  expect(deferred.world).toBeUndefined();
  expect(engine.getDiagnostics().persistence).toMatchObject({ mode: 'worker', pendingBatches: 0 });
});

test('shutdown flushes the final state once the writer is idle and then releases it', async () => {
  const persistence = new InFlightPersistence();
  const { engine, miner } = world(persistence);
  miner.score = 77;
  await engine.shutdownPersistence();
  expect(persistence.shutdownCalls).toBe(1);
  expect(persistence.batches.at(-1)?.pilots.map((pilot) => [pilot.id, pilot.score])).toEqual([
    [miner.id, 77],
  ]);
});

test('a deferred flush that fails while shutdown drains the writer still fails the shutdown', async () => {
  const persistence = new InFlightPersistence();
  const { engine, frame } = world(persistence);
  for (let tick = 0; tick < GAME.FPS; tick++) {
    frame();
  }
  // A flush is coalesced behind the in-flight commit; nothing awaits it.
  persistence.pendingBatches = 1;
  engine.checkpointWorld();
  expect(persistence.batches).toHaveLength(1);
  persistence.rejectNextBatchWith = new Error('World persistence is shutting down');
  const closing = engine.shutdownPersistence();
  persistence.drain();
  await expect(closing).rejects.toThrow('Persistent world checkpoint failed');
  expect(engine.isPersistenceHealthy()).toBe(false);
  expect(persistence.shutdownCalls).toBe(1);
});

test('shutdown waits a bounded time for an in-flight commit, then closes the writer and reports the skipped flush', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  cleanups.push(() => {
    vi.useRealTimers();
  });
  const persistence = new InFlightPersistence();
  const { engine, frame } = world(persistence);
  for (let tick = 0; tick < GAME.FPS; tick++) {
    frame();
  }
  expect(persistence.batches).toHaveLength(1);
  // The writer never answers; shutdown must not wait for the stall watchdog.
  persistence.pendingBatches = 1;
  const closing = engine.shutdownPersistence();
  const outcome = closing.then(
    () => 'resolved',
    (error: Error) => error.message
  );
  await vi.advanceTimersByTimeAsync(1_400);
  expect(persistence.shutdownCalls).toBe(0);
  await vi.advanceTimersByTimeAsync(200);
  expect(persistence.shutdownCalls).toBe(1);
  expect(await outcome).toBe(
    'World writer did not drain within 1500 ms; the final flush was skipped'
  );
  expect(persistence.batches).toHaveLength(1);
});

test('a persistence flush never parks a custom diagnostic belt in dormant regional sectors', () => {
  const store = new WorldStore(':memory:');
  cleanups.push(() => store.close());
  const { engine, miner, frame } = world(new InlineWorldPersistence(store));
  engine.prepareDiagnosticWorld('traversal');
  for (const rock of engine.getAllAsteroids()) {
    engine.removeAsteroid(rock.id);
  }
  const target = metalDeposit('diagnostic-nest-deposit', { x: 15_000, y: 5_000 });
  engine.addAsteroid(target);
  expect(
    engine.playerMotion.placeActorForTesting(miner.id, { x: 13_000, y: 5_000 }, WALL_ORIGIN_MS)
  ).toBe(true);
  miner.score = 321;
  engine.checkpointWorld();
  expect(engine.getAllAsteroids()).toContainEqual(target);
  expect(store.loadSector('7,2')).toBeUndefined();
  expect(store.loadPilots().find((pilot) => pilot.id === miner.id)?.score).toBe(321);
  for (let tick = 0; tick < GAME.FPS * 2; tick++) {
    frame();
  }
  expect(engine.getAllAsteroids()).toContainEqual(target);
  expect(engine.getSpiderField().nests).toContainEqual(
    expect.objectContaining({
      resourceId: target.id,
      position: target.position,
    })
  );
});
