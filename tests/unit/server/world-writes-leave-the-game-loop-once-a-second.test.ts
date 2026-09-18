/* @vitest-environment node */
import assert from 'node:assert/strict';
import { afterEach, expect, test, vi } from 'vitest';
import { GameEngine } from '../../../server/core/GameEngine';
import { ServerClock } from '../../../server/core/ServerClock';
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

function metalDeposit(id: string): AsteroidData {
  return {
    id,
    position: { x: 400, y: 300 },
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
  const { engine, miner, frame } = world(store);
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

class InFlightPersistence implements WorldPersistence {
  readonly batches: WorldCheckpoint[] = [];
  pendingBatches = 0;
  load(): LoadedWorld {
    return { world: undefined, sectors: new Map(), pilots: [] };
  }
  persist(batch: WorldCheckpoint): void {
    this.batches.push(batch);
  }
  reset(): void {}
  onFailure(): void {}
  whenIdle(): Promise<void> {
    return Promise.resolve();
  }
  shutdown(): Promise<void> {
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

test('a commit still in flight defers the next flush instead of queueing behind it', () => {
  const persistence = new InFlightPersistence();
  const { engine, frame } = world(persistence);
  expect(persistence.batches).toHaveLength(0);
  for (let tick = 0; tick < GAME.FPS; tick++) {
    frame();
  }
  expect(persistence.batches).toHaveLength(1);

  // The worker is still committing: this second's cadence passes without a new batch.
  persistence.pendingBatches = 1;
  for (let tick = 0; tick < GAME.FPS; tick++) {
    frame();
  }
  expect(persistence.batches).toHaveLength(1);

  // Once it drains, the following second carries everything that changed meanwhile.
  persistence.pendingBatches = 0;
  for (let tick = 0; tick < GAME.FPS; tick++) {
    frame();
  }
  expect(persistence.batches).toHaveLength(2);
  expect(engine.getDiagnostics().persistence).toMatchObject({ mode: 'worker', pendingBatches: 0 });
});
