// @vitest-environment node
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, test, vi } from 'vitest';
import { fixtureEvidenceMetadata } from '../../integration/utils/fixture-evidence';

function fixtureGit(root: string, args: string[], input?: string) {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (name.startsWith('GIT_')) {
      delete env[name];
    }
  }
  return execFileSync('git', args, {
    cwd: root,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 10_000,
    // Only this deliberately bounded fixture's independent oracle buffers a diff.
    maxBuffer: 8 * 1024 * 1024,
    ...(input !== undefined ? { input } : {}),
  });
}

test('a dirty scenario retains its complete large diff, binary change and untracked file fingerprint', async () => {
  const root = await mkdtemp(join(tmpdir(), 'georoids-fixture-evidence-'));
  try {
    fixtureGit(root, ['init']);
    await writeFile(join(root, '.git/info/exclude'), 'node_modules/\n');
    await mkdir(join(root, 'node_modules/playwright'), { recursive: true });
    await writeFile(join(root, 'node_modules/playwright/package.json'), '{"version":"1.63.0"}');
    await writeFile(join(root, 'scenario.txt'), '');
    await writeFile(join(root, 'binary.dat'), Buffer.from([0, 1, 2]));
    fixtureGit(root, ['add', '--', 'scenario.txt', 'binary.dat']);
    const tree = fixtureGit(root, ['write-tree']).toString('utf8').trim();
    const revision = fixtureGit(
      root,
      [
        '-c',
        'user.name=Fixture evidence',
        '-c',
        'user.email=fixture@example.invalid',
        'commit-tree',
        tree,
      ],
      'Fixture provenance baseline\n'
    )
      .toString('utf8')
      .trim();
    fixtureGit(root, ['update-ref', 'HEAD', revision]);
    const clean = await fixtureEvidenceMetadata(root);
    expect(clean.revision).toBe(revision);
    expect(clean.dirtyTree).toBe(false);
    expect(clean.diffDigest).toBe(createHash('sha256').digest('hex'));

    await writeFile(join(root, 'scenario.txt'), 'actual dirty scenario row\n'.repeat(90_000));
    await writeFile(join(root, 'binary.dat'), Buffer.from([0, 255, 3, 0, 7]));
    const untracked = Buffer.from('retained untracked evidence\n\u0000\u00e9', 'utf8');
    await writeFile(join(root, 'untracked.txt'), untracked);
    const diff = fixtureGit(root, ['diff', 'HEAD', '--binary']);
    expect(diff.length).toBeGreaterThan(1024 * 1024);
    const expected = createHash('sha256')
      .update(diff)
      .update('untracked.txt')
      .update(untracked)
      .digest('hex');
    const dirty = await fixtureEvidenceMetadata(root);
    expect(dirty.diffDigest).toBe(expected);
    expect(dirty.revision).toBe(revision);
    expect(dirty.dirtyTree).toBe(true);
    expect(dirty.playwrightVersion).toBe('1.63.0');
    expect(dirty.nodeVersion).toBe(process.version);

    await writeFile(join(root, 'untracked.txt'), Buffer.from('changed evidence'));
    expect((await fixtureEvidenceMetadata(root)).diffDigest).not.toBe(expected);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a scenario without a committed HEAD rejects provenance instead of retaining a partial digest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'georoids-fixture-evidence-'));
  try {
    fixtureGit(root, ['init']);
    await expect(fixtureEvidenceMetadata(root)).rejects.toThrow('git diff HEAD --binary failed');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === 'win32')(
  'an external diff descendant cannot hold fixture provenance open after its deadline',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'georoids-fixture-pipes-'));
    const ready = join(root, 'external-ready.json');
    const script = join(root, 'external-diff.cjs');
    let descendantPid: number | undefined;
    let groupCleaned = false;
    const failures: unknown[] = [];
    const deadlines = vi.spyOn(globalThis, 'setTimeout');
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      fixtureGit(root, ['init']);
      const tree = fixtureGit(root, ['mktree'], '').toString('utf8').trim();
      const revision = fixtureGit(
        root,
        [
          '-c',
          'user.name=Fixture evidence',
          '-c',
          'user.email=fixture@example.invalid',
          'commit-tree',
          tree,
        ],
        'Fixture inherited-pipe baseline\n'
      )
        .toString('utf8')
        .trim();
      fixtureGit(root, ['update-ref', 'HEAD', revision]);
      await writeFile(join(root, 'tracked.txt'), 'a dirty scenario\n');
      fixtureGit(root, ['add', '--', 'tracked.txt']);
      await writeFile(
        script,
        `#!/usr/bin/env node
const { spawn } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const held = spawn(process.execPath, ['-e', 'process.stdout.write("retained pipe bytes"); setInterval(() => {}, 1000)'], { stdio: ['ignore', 'inherit', 'inherit'] });
if (!held.pid) throw new Error('Owned descendant did not spawn');
writeFileSync(${JSON.stringify(ready)}, JSON.stringify({ pid: held.pid }));
process.exit(0);
`,
        { mode: 0o700 }
      );
      fixtureGit(root, ['config', 'diff.external', script]);
      const outcome = fixtureEvidenceMetadata(root).then(
        (value) => ({ kind: 'success', value }),
        (error: unknown) => ({ kind: 'failure', error })
      );
      const readyBy = performance.now() + 5000;
      while (descendantPid === undefined) {
        try {
          const value: unknown = JSON.parse(await readFile(ready, 'utf8'));
          if (
            !value ||
            typeof value !== 'object' ||
            !('pid' in value) ||
            typeof value.pid !== 'number' ||
            !Number.isSafeInteger(value.pid) ||
            value.pid <= 0
          ) {
            throw new Error('Invalid owned descendant receipt');
          }
          descendantPid = value.pid;
        } catch (error) {
          if (
            !(error instanceof Error && 'code' in error && error.code === 'ENOENT') ||
            performance.now() >= readyBy
          ) {
            throw error;
          }
          await delay(10);
        }
      }
      // Invoke the real installed deadline only after the real external child
      // holds the pipe; no 30-second sleep or fake packet/lifetime boundary.
      const deadline = deadlines.mock.calls
        .filter(([, milliseconds]) => milliseconds === 30_000)
        .at(-1)?.[0];
      if (typeof deadline !== 'function') {
        throw new Error('Fixture provenance deadline was not installed');
      }
      deadline();
      const result = await Promise.race([
        outcome,
        new Promise<never>((_resolve, reject) => {
          watchdog = setTimeout(
            () => reject(new Error('Owned fixture pipes did not settle')),
            5000
          );
        }),
      ]);
      expect(result.kind).toBe('failure');
      if (!('error' in result)) {
        throw new Error('Deadline accepted partial fixture provenance');
      }
      expect(result.error).toBeInstanceOf(Error);
      expect(String(result.error)).toContain('timed out');
      const stoppedBy = performance.now() + 5000;
      while (!groupCleaned && performance.now() < stoppedBy) {
        const state = spawnSync('ps', ['-o', 'stat=', '-p', String(descendantPid)], {
          encoding: 'utf8',
          maxBuffer: 1024,
          timeout: 1000,
        });
        if (state.error || state.signal || ![0, 1].includes(state.status ?? -1)) {
          throw new Error('Owned descendant state could not be verified', { cause: state.error });
        }
        const status = state.stdout.trim();
        // An orphaned zombie is already inactive and holds no output pipes.
        groupCleaned = status === '' || status.startsWith('Z');
        if (!groupCleaned) {
          await delay(10);
        }
      }
      expect(groupCleaned, 'the owned external-diff descendant must be inactive').toBe(true);
    } catch (error) {
      failures.push(error);
    } finally {
      if (watchdog !== undefined) {
        clearTimeout(watchdog);
      }
      deadlines.mockRestore();
      if (!groupCleaned && descendantPid !== undefined) {
        try {
          process.kill(descendantPid, 'SIGKILL');
        } catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) {
            failures.push(error);
          }
        }
      }
      try {
        await rm(root, { recursive: true, force: true });
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Owned external-diff deadline verification failed');
    }
  },
  15_000
);
