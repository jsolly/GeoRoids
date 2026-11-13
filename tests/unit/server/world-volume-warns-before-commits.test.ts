/* @vitest-environment node */
import fs, { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, test, vi } from 'vitest';
import { WorkerWorldPersistence } from '../../../server/world/WorkerWorldPersistence';
import { WorldStore } from '../../../server/world/WorldStore';
import type { WorldStoreWorkerRequest } from '../../../server/world/worldStoreWorkerProtocol';
import { sampleWorldVolume } from '../../../server/world/worldVolume';
import { logger } from '../../../setup/serverLogger';

// The filesystem cannot safely be filled in a test. Control that one OS boundary;
// leave SQLite, file sizes, volume sampling and adapter/logging behavior real.
vi.mock('node:worker_threads', async () => {
  const { EventEmitter } = await import('node:events');
  const { sampleWorldVolume: sample } = await import('../../../server/world/worldVolume');
  return {
    Worker: class extends EventEmitter {
      private readonly path: string;
      constructor(_url: URL, options: { workerData: { path: string } }) {
        super();
        this.path = options.workerData.path;
      }
      postMessage(request: WorldStoreWorkerRequest): void {
        if (request.type === 'shutdown') {
          queueMicrotask(() => this.emit('exit', 0));
          return;
        }
        this.emit('message', { type: 'volume', volume: sample(this.path) });
        this.emit('message', { type: 'done', id: request.id, durationMs: 0 });
      }
    },
  };
});

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

function worldFile(): string {
  const directory = mkdtempSync(join(tmpdir(), 'georoids-volume-'));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'world.sqlite');
  const store = new WorldStore(path, { intent: 'private' });
  cleanups.push(() => store.close());
  return path;
}

test('a low volume warns once per episode while commits continue and disk reads stay out of diagnostics', () => {
  const path = worldFile();
  const actual = fs.statfsSync(tmpdir());
  const disk = vi
    .spyOn(fs, 'statfsSync')
    .mockReturnValue({ ...actual, bsize: 1, bavail: 300 * 1024 * 1024 });
  const warning = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  const persistence = new WorkerWorldPersistence(path, { intent: 'private' });
  cleanups.push(() => persistence.shutdown());
  expect(persistence.diagnostics().volume).toEqual({ status: 'pending' });
  const commit = (): void => persistence.persist({ sectors: new Map(), pilots: [] });
  commit();
  commit();
  expect(persistence.diagnostics()).toMatchObject({
    committedBatches: 2,
    failed: false,
    volume: { status: 'low', freeBytes: 300 * 1024 * 1024, warningBytes: 384 * 1024 * 1024 },
  });
  expect(warning).toHaveBeenCalledTimes(1);
  expect(warning).toHaveBeenCalledWith(
    'WORLD',
    'world_volume_low',
    expect.objectContaining({ freeBytes: 300 * 1024 * 1024 })
  );
  const reads = disk.mock.calls.length;
  for (let frame = 0; frame < 60; frame++) {
    persistence.diagnostics();
  }
  expect(disk).toHaveBeenCalledTimes(reads);
  disk.mockReturnValue({ ...actual, bsize: 1, bavail: 500 * 1024 * 1024 });
  commit();
  expect(persistence.diagnostics().volume?.status).toBe('ok');
  disk.mockReturnValue({ ...actual, bsize: 1, bavail: 200 * 1024 * 1024 });
  commit();
  expect(warning).toHaveBeenCalledTimes(2);
});

test('unavailable disk measurements are explicit, log a bounded error and recover without failing commits', () => {
  const path = worldFile();
  const actual = fs.statfsSync(tmpdir());
  const disk = vi.spyOn(fs, 'statfsSync').mockImplementation(() => {
    throw Object.assign(new Error('private path'), { code: 'EACCES' });
  });
  const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
  const persistence = new WorkerWorldPersistence(path, { intent: 'private' });
  cleanups.push(() => persistence.shutdown());
  const commit = (): void => persistence.persist({ sectors: new Map(), pilots: [] });
  commit();
  commit();
  expect(persistence.diagnostics()).toMatchObject({
    failed: false,
    committedBatches: 2,
    volume: { status: 'unavailable', errorCode: 'EACCES' },
  });
  expect(JSON.stringify(persistence.diagnostics())).not.toContain('private path');
  expect(error).toHaveBeenCalledTimes(1);
  expect(error).toHaveBeenCalledWith(
    'WORLD',
    'world_volume_inspection_failed',
    expect.objectContaining({ errorCode: 'EACCES' })
  );
  disk.mockReturnValue(actual);
  commit();
  expect(persistence.diagnostics().volume?.status).toBe('ok');
});

test('volume samples report the real database and WAL sizes and reject invalid counters', () => {
  const path = worldFile();
  const volume = sampleWorldVolume(path);
  expect(volume).toMatchObject({
    databaseBytes: statSync(path).size,
    walBytes: statSync(`${path}-wal`).size,
  });
  const actual = fs.statfsSync(tmpdir());
  vi.spyOn(fs, 'statfsSync').mockReturnValue({ ...actual, bsize: Number.MAX_VALUE, bavail: 2 });
  expect(sampleWorldVolume(path)).toMatchObject({ status: 'unavailable' });
});

test('world writes checkpoint the WAL before it grows to the SQLite default threshold', () => {
  const path = worldFile();
  const store = new WorldStore(path, { intent: 'private' });
  try {
    store.checkpoint(
      undefined,
      new Map(),
      Array.from({ length: 12_000 }, (_, index) => ({
        id: `pilot-${index}`,
        name: 'Pilot',
        score: 0,
        tokenHash: 'a'.repeat(64),
      }))
    );
    // More than 256 pages, fewer than the default 1,000. Auto-checkpointing
    // must have moved the committed rows from WAL into the actual database.
    expect(statSync(`${path}-wal`).size).toBeGreaterThan(256 * 4096);
    expect(statSync(`${path}-wal`).size).toBeLessThan(1000 * 4096);
    expect(statSync(path).size).toBeGreaterThan(256 * 4096);
    const reader = new DatabaseSync(path, { readOnly: true });
    try {
      expect(reader.prepare('SELECT count(*) n FROM pilots').get()?.['n']).toBe(12_000);
    } finally {
      reader.close();
    }
  } finally {
    store.close();
  }
});
