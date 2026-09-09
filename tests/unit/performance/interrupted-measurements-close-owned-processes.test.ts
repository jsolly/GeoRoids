// @vitest-environment node
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { commands } from '../../../benchmarks/run';

function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') {
      return false;
    }
    throw error;
  }
}

it('cancelling a measurement stops its uncooperative child and grandchild and retains the failure', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'georoids-benchmark-cancellation-'));
  const controller = new AbortController();
  const pids: number[] = [];
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
    controller.abort(new Error('Operator cancelled measurement'));
    expect(await outcome).toBeInstanceOf(AggregateError);
    expect(pids.map(running)).toEqual([false, false]);
    const record = await readFile(join(directory, 'command-1.json'), 'utf8');
    expect(record).toContain('Operator cancelled measurement');
    expect(record).toContain('SIGKILL');
  } finally {
    controller.abort(new Error('Test cleanup'));
    await outcome;
    for (const pid of pids) {
      if (running(pid)) {
        process.kill(pid, 'SIGKILL');
      }
    }
    await rm(directory, { recursive: true, force: true });
  }
}, 20_000);

it('a failed compiler preserves its exit status and diagnostic output', async () => {
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
