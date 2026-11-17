// @vitest-environment node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { type FileHandle, mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it as test, vi } from 'vitest';
import { commands } from '../../../benchmarks/run';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: vi.fn(actual.open) };
});

function running(pid: number): boolean {
  const result = spawnSync('ps', ['-p', String(pid), '-o', 'stat='], { encoding: 'utf8' });
  assert(!result.error && !result.signal && !result.stderr.trim());
  if (result.status === 1 && !result.stdout.trim()) {
    return false;
  }
  assert.equal(result.status, 0);
  return !result.stdout.trim().startsWith('Z');
}

test.each(['working', 'missing', 'failing'])(
  'cancelling a measurement stops its uncooperative descendants with %s process inspection',
  async (inspection) => {
    const directory = await mkdtemp(join(tmpdir(), 'georoids-benchmark-cancellation-'));
    const controller = new AbortController();
    const pids: number[] = [];
    const originalPath = process.env['PATH'];
    const signals = vi.spyOn(process, 'kill');
    let outcome: Promise<unknown> | undefined;
    try {
      const fixture = join(directory, 'workload.mjs');
      await writeFile(
        fixture,
        `
      import { spawn } from 'node:child_process';
      import { writeFileSync } from 'node:fs';
      process.on('SIGTERM', () => {});
      const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); process.stdout.write('ready'); setInterval(() => {}, 1000);"], { stdio: ['ignore', 'pipe', 'inherit'] });
      child.stdout.once('data', () => writeFileSync(process.argv[2], JSON.stringify([process.pid, child.pid])));
      setInterval(() => {}, 1000);
    `
      );
      outcome = commands(directory, controller.signal)(
        process.execPath,
        [fixture, join(directory, 'pids.json')],
        directory,
        10_000
      ).then(
        () => undefined,
        (error: unknown) => error
      );
      const readyDeadline = Date.now() + 5_000;
      let ready = false;
      while (!ready && Date.now() < readyDeadline) {
        try {
          const values: unknown = JSON.parse(await readFile(join(directory, 'pids.json'), 'utf8'));
          if (
            !Array.isArray(values) ||
            values.length !== 2 ||
            !values.every((pid: unknown) => typeof pid === 'number' && pid > 0)
          ) {
            throw new Error('Invalid workload process IDs');
          }
          pids.push(...values);
          ready = true;
        } catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
            throw error;
          }
          await delay(20);
        }
      }
      expect(ready, 'The owned workload must start before cancellation').toBe(true);
      expect(pids.every(running)).toBe(true);
      const ownedPid = pids[0];
      assert(ownedPid !== undefined);
      if (inspection !== 'working') {
        const inspector = join(directory, 'inspector');
        await mkdir(inspector);
        if (inspection === 'failing') {
          await writeFile(
            join(inspector, 'ps'),
            '#!/bin/sh\necho "fixture inspection failed" >&2\nexit 71\n',
            {
              mode: 0o755,
            }
          );
        }
        vi.stubEnv('PATH', inspector);
      }
      controller.abort(new Error('Operator cancelled measurement'));
      const failure = await outcome;
      vi.stubEnv('PATH', originalPath);
      expect(failure).toBeInstanceOf(AggregateError);
      expect(pids.map(running)).toEqual([false, false]);
      expect(signals).toHaveBeenCalledWith(-ownedPid, 'SIGTERM');
      expect(signals).toHaveBeenCalledWith(-ownedPid, 'SIGKILL');
      const record = await readFile(join(directory, 'command-1.json'), 'utf8');
      expect(record).toContain('Operator cancelled measurement');
      expect(record).toContain('SIGKILL');
      if (inspection === 'working') {
        expect(JSON.parse(record)).toMatchObject({ errors: [{ name: 'AbortError' }] });
      } else {
        expect(record).not.toContain('TypeError');
        expect(JSON.parse(record)).toMatchObject({
          errors: expect.arrayContaining([
            expect.objectContaining({ name: 'AbortError' }),
            expect.objectContaining({
              name: 'AssertionError',
              message: expect.stringContaining('Cannot inspect measurement process group'),
            }),
          ]),
        });
      }
    } finally {
      vi.stubEnv('PATH', originalPath);
      controller.abort(new Error('Test cleanup'));
      await outcome;
      for (const pid of pids) {
        if (running(pid)) {
          process.kill(pid, 'SIGKILL');
        }
      }
      await rm(directory, { recursive: true, force: true });
      signals.mockRestore();
    }
  },
  20_000
);

test('a failed compiler preserves its exit status and diagnostic output', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'georoids-benchmark-compiler-'));
  try {
    const run = commands(directory, new AbortController().signal);
    await expect(
      run(process.execPath, [
        '-e',
        "process.stderr.write('fixture compilation failed'); process.exitCode = 7;",
      ])
    ).rejects.toThrow('Command failed');
    expect(await readFile(join(directory, 'command-1.stderr.log'), 'utf8')).toBe(
      'fixture compilation failed'
    );
    const record: unknown = JSON.parse(await readFile(join(directory, 'command-1.json'), 'utf8'));
    expect(record).toMatchObject({ exitCode: 7, signal: null });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a second log collision closes the first real file and retains the setup failure', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'georoids-benchmark-log-collision-'));
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  const handles: FileHandle[] = [];
  const openedFds: number[] = [];
  vi.mocked(open).mockImplementation(async (...args) => {
    const handle = await actual.open(...args);
    handles.push(handle);
    openedFds.push(handle.fd);
    return handle;
  });
  try {
    await writeFile(join(directory, 'command-1.stderr.log'), 'occupied', { flag: 'wx' });
    const failure: unknown = await commands(directory, new AbortController().signal)(
      process.execPath,
      ['--version']
    ).then(
      () => undefined,
      (error: unknown) => error
    );
    const errors: unknown[] = failure instanceof AggregateError ? failure.errors : [failure];
    expect(errors).toEqual([expect.objectContaining({ code: 'EEXIST' })]);
    expect(handles).toHaveLength(1);
    expect(openedFds[0]).toBeGreaterThanOrEqual(0);
    expect(handles[0]?.fd).toBe(-1);
    expect(await readFile(join(directory, 'command-1.stderr.log'), 'utf8')).toBe('occupied');
    expect(failure).toBeInstanceOf(AggregateError);
    const record: unknown = JSON.parse(await readFile(join(directory, 'command-1.json'), 'utf8'));
    expect(record).toMatchObject({
      exitCode: null,
      signal: null,
      errors: [{ message: expect.stringContaining('EEXIST') }],
    });
  } finally {
    vi.mocked(open).mockImplementation(actual.open);
    try {
      await Promise.all(handles.map((handle) => handle.close()));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test('log close failures close both real files and remain in the command failure record', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'georoids-benchmark-log-close-'));
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  const handles: FileHandle[] = [];
  const restores: Array<() => void> = [];
  vi.mocked(open).mockImplementation(async (...args) => {
    const handle = await actual.open(...args);
    const message = handles.length === 0 ? 'stdout close failed' : 'stderr close failed';
    handles.push(handle);
    const close = handle.close.bind(handle);
    const spy = vi.spyOn(handle, 'close').mockImplementation(async () => {
      await close();
      throw new Error(message);
    });
    restores.push(() => spy.mockRestore());
    return handle;
  });
  try {
    const failure: unknown = await commands(directory, new AbortController().signal)(
      process.execPath,
      ['-e', "process.stdout.write('completed')"]
    ).then(
      () => undefined,
      (error: unknown) => error
    );
    expect(handles).toHaveLength(2);
    expect(handles.map((handle) => handle.fd)).toEqual([-1, -1]);
    expect(failure).toBeInstanceOf(AggregateError);
    expect(await readFile(join(directory, 'command-1.stdout.log'), 'utf8')).toBe('completed');
    const record: unknown = JSON.parse(await readFile(join(directory, 'command-1.json'), 'utf8'));
    expect(record).toMatchObject({
      exitCode: 0,
      signal: null,
      errors: [{ message: 'stdout close failed' }, { message: 'stderr close failed' }],
    });
  } finally {
    vi.mocked(open).mockImplementation(actual.open);
    for (const restore of restores) {
      restore();
    }
    try {
      await Promise.all(handles.map((handle) => handle.close()));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});
