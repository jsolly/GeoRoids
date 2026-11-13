/* @vitest-environment node */
import fs, { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parentPort } from 'node:worker_threads';
import { expect, test, vi } from 'vitest';
import { createPrivateWorld } from '../../support/privateWorld';

const state = vi.hoisted(() => ({ path: '' }));
vi.mock('node:worker_threads', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    isMainThread: false,
    workerData: {
      intent: 'existing',
      get path() {
        return state.path;
      },
    },
    parentPort: new (class extends EventEmitter {
      postMessage(_message: unknown): void {}
      close(): void {
        this.emit('close');
      }
    })(),
  };
});

test('the idle writer refreshes disk health and shutdown removes its sampling timer', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'georoids-idle-volume-'));
  state.path = join(directory, 'world.sqlite');
  createPrivateWorld(state.path).close();
  if (!parentPort) {
    throw new Error('Worker fixture has no parent port');
  }
  const reply = vi.spyOn(parentPort, 'postMessage');
  const actual = fs.statfsSync(tmpdir());
  const disk = vi
    .spyOn(fs, 'statfsSync')
    .mockReturnValue({ ...actual, bsize: 1, bavail: 500 * 1024 * 1024 });
  vi.useFakeTimers();
  let stopped = false;
  try {
    await import('../../../server/world/worldStoreWorker');
    expect(reply).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: 'volume', volume: expect.objectContaining({ status: 'ok' }) })
    );
    disk.mockReturnValue({ ...actual, bsize: 1, bavail: 200 * 1024 * 1024 });
    vi.advanceTimersByTime(30_000);
    expect(reply).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: 'volume',
        volume: expect.objectContaining({ status: 'low', freeBytes: 200 * 1024 * 1024 }),
      })
    );
    parentPort.emit('message', { type: 'shutdown', id: 1 });
    stopped = true;
    expect(reply).toHaveBeenLastCalledWith({ type: 'done', id: 1, durationMs: 0 });
    const replies = reply.mock.calls.length;
    vi.advanceTimersByTime(60_000);
    expect(reply).toHaveBeenCalledTimes(replies);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    if (!stopped) {
      parentPort.emit('message', { type: 'shutdown', id: 2 });
    }
    vi.useRealTimers();
    vi.restoreAllMocks();
    rmSync(directory, { recursive: true, force: true });
  }
});
