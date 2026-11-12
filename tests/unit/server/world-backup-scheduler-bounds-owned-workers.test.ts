/* @vitest-environment node */
import { ChildProcess } from 'node:child_process';
import { afterEach, expect, test, vi } from 'vitest';
import { startBackupScheduler } from '../../../server/backups/scheduler';

const spawnWorker = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: spawnWorker,
}));

const schedulers: ReturnType<typeof startBackupScheduler>[] = [];
afterEach(async () => {
  for (const activeScheduler of schedulers.splice(0)) {
    await activeScheduler.close();
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
  spawnWorker.mockReset();
});
function scheduler() {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-12T23:50:00Z'));
  const workers: ChildProcess[] = [];
  spawnWorker.mockImplementation(() => {
    const child = new ChildProcess();
    vi.spyOn(child, 'kill').mockImplementation(() => {
      child.emit('close', null, 'SIGKILL');
      return true;
    });
    workers.push(child);
    return child;
  });
  const report = vi.fn();
  const active = startBackupScheduler({
    configuration: {
      bucket: 'fixture-private',
      region: 'us-east-1',
      stagingDirectory: '/fixture/stage',
    },
    worldPath: '/fixture/world.sqlite',
    report,
  });
  schedulers.push(active);
  return { active, workers, report };
}
function first(workers: ChildProcess[]): ChildProcess {
  const child = workers[0];
  if (!child) {
    throw new Error('Expected one spawned worker');
  }
  return child;
}

test('restart starts immediately, verified IPC schedules the next UTC day, and success without evidence fails', async () => {
  const { workers, report } = scheduler();
  await vi.advanceTimersByTimeAsync(0);
  const receipt = {
    sha256: 'a'.repeat(64),
    worldIdentity: 'b'.repeat(64),
    bytes: 4096,
    generation: 1,
    sectors: 0,
    pilots: 1,
    explorationTiles: 0,
    cooperativeRecords: 0,
  };
  first(workers).emit('message', {
    kind: 'verified',
    receipt: { day: '2026-11-12', daily: receipt, weekly: receipt },
  });
  first(workers).emit('close', 0);
  expect(report).toHaveBeenCalledWith({
    kind: 'backup_verified',
    receipt: { day: '2026-11-12', daily: receipt, weekly: receipt },
  });
  await vi.advanceTimersByTimeAsync(599999);
  expect(workers).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(workers).toHaveLength(2);
  workers[1]?.emit('close', 0);
  expect(report).toHaveBeenLastCalledWith({ kind: 'backup_failed', stage: 'worker' });
});

test('a hung native worker is killed at the deadline, retries once, and shutdown cancels every future timer', async () => {
  const { active, workers, report } = scheduler();
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(300000);
  expect(first(workers).kill).toHaveBeenCalledWith('SIGKILL');
  expect(report).toHaveBeenCalledWith({ kind: 'backup_deadline' });
  await vi.advanceTimersByTimeAsync(900000);
  expect(workers).toHaveLength(2);
  await active.close();
  expect(workers[1]?.kill).toHaveBeenCalledWith('SIGKILL');
  expect(report).toHaveBeenLastCalledWith({ kind: 'backup_shutdown' });
  await vi.advanceTimersByTimeAsync(86400000);
  expect(workers).toHaveLength(2);
});

test('a verified job that crosses UTC midnight immediately schedules the new day instead of skipping it', async () => {
  const { workers } = scheduler();
  await vi.advanceTimersByTimeAsync(0);
  vi.setSystemTime(new Date('2026-11-13T00:01:00Z'));
  const receipt = {
    sha256: 'a'.repeat(64),
    worldIdentity: 'b'.repeat(64),
    bytes: 4096,
    generation: 1,
    sectors: 0,
    pilots: 1,
    explorationTiles: 0,
    cooperativeRecords: 0,
  };
  first(workers).emit('message', {
    kind: 'verified',
    receipt: { day: '2026-11-12', daily: receipt, weekly: receipt },
  });
  first(workers).emit('close', 0);
  await vi.advanceTimersByTimeAsync(1);
  expect(workers).toHaveLength(2);
});
