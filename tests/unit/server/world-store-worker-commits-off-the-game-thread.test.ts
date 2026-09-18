/* @vitest-environment node */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { WorkerWorldPersistence } from '../../../server/world/WorkerWorldPersistence';
import { WorldStore } from '../../../server/world/WorldStore';
import {
  includesUnreleasedWriter,
  type WorldCheckpoint,
  WorldWriterUnreleasedError,
} from '../../../server/world/worldPersistence';
import { WORLD } from '../../../shared/world';
import type { AsteroidData } from '../../../shared-types';

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

function worldFile(): string {
  const directory = mkdtempSync(join(tmpdir(), 'georoids-worker-store-'));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, 'world.sqlite');
}

function deposit(id: string, position: { x: number; y: number }): AsteroidData {
  return {
    id,
    position,
    velocity: { x: 0, y: 0 },
    size: 25,
    material: 'metal',
    health: 75,
    maxHealth: 75,
    jaggedness: 0.2,
    rotation: 0,
    angularVelocity: 0,
    vertices: 4,
    offsets: [1, 1, 1, 1],
  };
}

function batch(sectors: ReadonlyMap<string, AsteroidData[]>, score: number): WorldCheckpoint {
  return {
    world: {
      seed: 7,
      startedAt: 1,
      generation: WORLD.generation,
      scoreSeason: '2026-09',
      exploration: [],
      completedSectors: [],
    },
    sectors,
    pilots: [{ id: 'pilot', tokenHash: 'a'.repeat(64), name: 'Pilot', score }],
  };
}

function reopen(path: string): WorldStore {
  const store = new WorldStore(path);
  cleanups.push(() => store.close());
  return store;
}

/** `shutdown()` is idempotent, so the test body may await it too; a rejection here fails the test. */
function shutDownAfter(persistence: WorkerWorldPersistence): void {
  cleanups.push(() => persistence.shutdown());
}

/** For adapters the test has failed on purpose: shutdown must reject, and with that failure. */
function expectFailedShutdownAfter(persistence: WorkerWorldPersistence, message: string): void {
  cleanups.push(() => expect(persistence.shutdown()).rejects.toThrow(message));
}

test('batches handed to the worker are committed in order and survive a reopen', async () => {
  const path = worldFile();
  const persistence = new WorkerWorldPersistence(path);
  shutDownAfter(persistence);
  expect(persistence.load()).toEqual({ world: undefined, sectors: new Map(), pilots: [] });

  persistence.persist(batch(new Map([['0,0', [deposit('ore', { x: 20, y: 20 })]]]), 10));
  persistence.persist({ sectors: new Map([['0,0', []]]), pilots: batch(new Map(), 25).pilots });
  expect(persistence.diagnostics()).toMatchObject({ mode: 'worker', pendingBatches: 2 });
  await persistence.whenIdle();
  expect(persistence.diagnostics()).toMatchObject({
    pendingBatches: 0,
    committedBatches: 2,
    failed: false,
  });
  expect(persistence.diagnostics().lastCommitMs).toBeGreaterThanOrEqual(0);
  await persistence.shutdown();

  const saved = reopen(path);
  expect(saved.loadSector('0,0')).toEqual([]);
  expect(saved.loadPilots().find((pilot) => pilot.id === 'pilot')?.score).toBe(25);
  // The second batch carried no world row; the first one's row is still there.
  expect(saved.loadWorld()?.seed).toBe(7);
});

test('shutdown commits the batch still in flight before releasing the database', async () => {
  const path = worldFile();
  const persistence = new WorkerWorldPersistence(path);
  persistence.load();
  persistence.persist(batch(new Map([['1,0', [deposit('late-ore', { x: 2_100, y: 20 })]]]), 40));
  await persistence.shutdown();
  expect(persistence.diagnostics()).toMatchObject({ pendingBatches: 0, committedBatches: 1 });
  const saved = reopen(path);
  expect(saved.loadSector('1,0')?.map((rock) => rock.id)).toEqual(['late-ore']);
  expect(saved.loadPilots().find((pilot) => pilot.id === 'pilot')?.score).toBe(40);
});

test('a reset queued behind a batch erases it, and a batch queued behind the reset survives', async () => {
  const path = worldFile();
  const persistence = new WorkerWorldPersistence(path);
  shutDownAfter(persistence);
  persistence.load();
  persistence.persist(batch(new Map([['0,0', [deposit('doomed', { x: 20, y: 20 })]]]), 10));
  persistence.reset();
  persistence.persist(batch(new Map([['1,0', [deposit('kept', { x: 2_100, y: 20 })]]]), 30));
  // Idle means the reset has been applied too, not only the batches around it.
  expect(persistence.diagnostics().pendingBatches).toBe(3);
  await persistence.whenIdle();
  expect(persistence.diagnostics()).toMatchObject({ pendingBatches: 0, committedBatches: 2 });
  await persistence.shutdown();

  const saved = reopen(path);
  expect(saved.loadSector('0,0')).toBeUndefined();
  expect(saved.loadSector('1,0')?.map((rock) => rock.id)).toEqual(['kept']);
  expect(saved.loadPilots().find((pilot) => pilot.id === 'pilot')?.score).toBe(30);
});

test('a batch the worker cannot commit fails the adapter once, and nothing queued behind it lands', async () => {
  const path = worldFile();
  const persistence = new WorkerWorldPersistence(path);
  expectFailedShutdownAfter(persistence, 'Saved sector 0,0');
  persistence.load();
  const failures: Error[] = [];
  persistence.onFailure((error) => failures.push(error));

  // A deposit whose position lies outside its sector is refused by the store's validation.
  persistence.persist(batch(new Map([['0,0', [deposit('stray', { x: 5_000, y: 5_000 })]]]), 5));
  // Handed over in the same turn, before the failure could be reported back:
  // it was built on memory the database will never match, so it must not commit.
  persistence.persist(batch(new Map([['1,0', [deposit('follower', { x: 2_100, y: 20 })]]]), 25));
  await persistence.whenIdle();
  expect(failures).toHaveLength(1);
  expect(failures[0]?.message).toContain('Saved sector 0,0');
  expect(persistence.diagnostics()).toMatchObject({
    failed: true,
    pendingBatches: 0,
    committedBatches: 0,
  });
  expect(() => persistence.persist(batch(new Map(), 6))).toThrow('Saved sector 0,0');
  await expect(persistence.shutdown()).rejects.toThrow('Saved sector 0,0');

  const saved = reopen(path);
  expect(saved.loadPilots()).toEqual([]);
  expect(saved.loadSector('0,0')).toBeUndefined();
  expect(saved.loadSector('1,0')).toBeUndefined();
  expect(saved.loadWorld()).toBeUndefined();
});

test('a worker that stops answering fails the adapter instead of leaving the loop trusting memory', () => {
  // The watchdog reads the monotonic clock, so a wall-clock step cannot trip it.
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'],
  });
  cleanups.push(() => {
    vi.useRealTimers();
  });
  const path = worldFile();
  const persistence = new WorkerWorldPersistence(path, { stallTimeoutMs: 1_000 });
  expectFailedShutdownAfter(persistence, 'World store worker unresponsive');
  const failures: Error[] = [];
  persistence.onFailure((error) => failures.push(error));
  persistence.persist(batch(new Map(), 1));
  expect(persistence.diagnostics()).toMatchObject({ pendingBatches: 1, failed: false });

  // No reply can have arrived yet; the watchdog sees the batch outlive its limit.
  vi.advanceTimersByTime(6_000);
  expect(failures).toHaveLength(1);
  expect(failures[0]?.message).toContain('World store worker unresponsive');
  expect(persistence.diagnostics()).toMatchObject({ pendingBatches: 0, failed: true });
});

test('handing over more batches than the writer could ever be behind by fails closed', () => {
  const path = worldFile();
  const persistence = new WorkerWorldPersistence(path);
  expectFailedShutdownAfter(persistence, 'not keeping up');
  const failures: Error[] = [];
  persistence.onFailure((error) => failures.push(error));
  for (let round = 0; round < 4; round++) {
    persistence.persist(batch(new Map(), round));
  }
  expect(persistence.diagnostics()).toMatchObject({ pendingBatches: 4, failed: false });
  expect(() => persistence.persist(batch(new Map(), 4))).toThrow(
    'World store worker is not keeping up with world batches'
  );
  expect(failures).toHaveLength(1);
  expect(persistence.diagnostics().failed).toBe(true);
});

test('a writer that never released is recognised anywhere in the shutdown error tree', () => {
  const unreleased = new WorldWriterUnreleasedError('World store worker did not release', {
    cause: new Error('database is locked'),
  });
  expect(includesUnreleasedWriter(unreleased)).toBe(true);
  expect(
    includesUnreleasedWriter(new Error('Persistent world checkpoint failed', { cause: unreleased }))
  ).toBe(true);
  expect(
    includesUnreleasedWriter(
      new AggregateError(
        [new Error('Server shutdown timed out'), new Error('wrapped', { cause: unreleased })],
        'Server shutdown did not complete cleanly'
      )
    )
  ).toBe(true);
  expect(
    includesUnreleasedWriter(
      new Error('Persistent world checkpoint failed', { cause: new Error('database is locked') })
    )
  ).toBe(false);
  expect(includesUnreleasedWriter('not an error')).toBe(false);
  const loop = new Error('loop');
  loop.cause = loop;
  expect(includesUnreleasedWriter(loop)).toBe(false);
});

test('an in-memory world refuses the worker adapter because threads cannot share it', () => {
  expect(() => new WorkerWorldPersistence(':memory:')).toThrow(
    'An in-memory world cannot be shared with a worker thread'
  );
});
