/* @vitest-environment node */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { afterEach, expect, test } from 'vitest';
import { rehearseRestore } from '../../../server/backups/rehearsal';
import { createSnapshot } from '../../../server/backups/snapshot';
import { WorldStore } from '../../../server/world/WorldStore';
import { WORLD } from '../../../shared/world';

const directories: string[] = [];
afterEach(() => {
  for (const path of directories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

async function artifact() {
  const directory = mkdtempSync(join(tmpdir(), 'georoids-restore-drill-'));
  directories.push(directory);
  const worldPath = join(directory, 'fixture.sqlite');
  const store = new WorldStore(worldPath, { intent: 'private' });
  try {
    store.checkpoint({ seed: 83, startedAt: 10000, generation: WORLD.generation }, new Map(), [
      {
        id: 'saved-pilot',
        name: 'Saved pilot',
        tokenHash: 'a'.repeat(64),
        score: 7300,
        cargo: 715,
      },
    ]);
  } finally {
    store.close();
  }
  const path = join(directory, 'artifact.sqlite');
  const receipt = await createSnapshot(worldPath, path);
  return { directory, path, receipt };
}

test('the restore rehearsal boots an isolated copy, accepts genuine join movement and firing, flushes persistence and cleans up', async () => {
  const { directory, path, receipt } = await artifact();
  const bytes = readFileSync(path);
  const scratchDirectory = join(directory, 'new-rehearsal');
  await expect(
    rehearseRestore({ artifact: path, expectedSha256: receipt.sha256, scratchDirectory })
  ).resolves.toEqual({
    artifact: receipt,
    boot: true,
    join: true,
    movement: true,
    firing: true,
    persistence: true,
  });
  expect(readFileSync(path)).toEqual(bytes);
  expect(existsSync(scratchDirectory)).toBe(false);
});

test('a wrong artifact digest or an existing destination refuses without altering evidence or prior files', async () => {
  const { directory, path } = await artifact();
  const scratchDirectory = join(directory, 'existing');
  mkdirSync(scratchDirectory);
  const sentinel = join(scratchDirectory, 'keep.txt');
  writeFileSync(sentinel, 'retained');
  await expect(
    rehearseRestore({ artifact: path, expectedSha256: '0'.repeat(64), scratchDirectory })
  ).rejects.toThrow('SHA256');
  const receipt = await createSnapshot(path, join(directory, 'copy.sqlite'));
  await expect(
    rehearseRestore({ artifact: path, expectedSha256: receipt.sha256, scratchDirectory })
  ).rejects.toThrow('EEXIST');
  expect(readFileSync(sentinel, 'utf8')).toBe('retained');
});

test('the real restore CLI refuses Railway before loading player data and prints only its fixed error event', async () => {
  const { directory, path, receipt } = await artifact();
  const scratchDirectory = join(directory, 'forbidden-railway-rehearsal');
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      'scripts/rehearse-world-restore.ts',
      path,
      receipt.sha256,
      scratchDirectory,
    ],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, RAILWAY_ENVIRONMENT_ID: 'fixture-private-environment' },
    }
  );
  expect(result.status).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toBe('{"level":"error","event":"local_restore_rehearsal_failed"}\n');
  expect(existsSync(scratchDirectory)).toBe(false);
});
