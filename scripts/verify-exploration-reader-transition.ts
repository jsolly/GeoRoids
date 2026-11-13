import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import process from 'node:process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { GameEngine } from '../server/core/GameEngine';
import {
  explorationStorageFingerprint,
  inspectExplorationStorage,
  transitionExplorationStorage,
} from '../server/world/explorationSchema';
import { WorkerWorldPersistence } from '../server/world/WorkerWorldPersistence';
import { WorldStore } from '../server/world/WorldStore';
import { validExploration } from '../shared/exploration';
import type { ExplorationTile } from '../shared-types';

const candidate = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceTrees = ['server', 'shared', 'setup', 'shared-types.ts'];
function sourceFiles(path: string): string[] {
  return readdirSync(path, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      if (entry.isSymbolicLink()) {
        throw new Error('Compatibility source must contain ordinary files');
      }
      const child = join(path, entry.name);
      return entry.isDirectory() ? sourceFiles(child) : [child];
    });
}
function sourceDigest(root: string): string {
  const hash = createHash('sha256');
  for (const name of sourceTrees) {
    const paths = name.endsWith('.ts') ? [join(root, name)] : sourceFiles(join(root, name));
    for (const path of paths) {
      hash.update(JSON.stringify(relative(root, path)));
      hash.update(createHash('sha256').update(readFileSync(path)).digest());
    }
  }
  return hash.digest('hex');
}
interface LegacyReceipt {
  exploration: ExplorationTile[];
  progressDigest: string;
}
function legacyReceipt(value: unknown): LegacyReceipt {
  if (
    value === null ||
    typeof value !== 'object' ||
    !('exploration' in value) ||
    !validExploration(value.exploration) ||
    !('progressDigest' in value) ||
    typeof value.progressDigest !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(value.progressDigest)
  ) {
    throw new Error('Invalid legacy consumer receipt');
  }
  return { exploration: value.exploration, progressDigest: value.progressDigest };
}

const [action, legacyRoot, expectedSourceSha, scratch] = process.argv.slice(2);
if (!legacyRoot || !isAbsolute(legacyRoot) || (action !== 'inspect' && action !== 'run')) {
  throw new Error(
    'Usage: inspect ABSOLUTE_LEGACY_SOURCE, or run ABSOLUTE_LEGACY_SOURCE EXPECTED_SOURCE_SHA NEW_ABSOLUTE_SCRATCH'
  );
}
const sourceSha256 = sourceDigest(legacyRoot);
if (action === 'inspect') {
  process.stdout.write(`${JSON.stringify({ sourceSha256 })}\n`);
} else {
  if (sourceSha256 !== expectedSourceSha || !scratch || !isAbsolute(scratch)) {
    throw new Error('Expected exact pinned legacy source and new absolute scratch directory');
  }
  mkdirSync(scratch, { mode: 0o700 });
  const old = join(scratch, 'legacy-source');
  mkdirSync(old);
  for (const name of sourceTrees) {
    cpSync(join(legacyRoot, name), join(old, name), {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
  }
  assert.equal(sourceDigest(old), sourceSha256);
  // Dependency reuse does not change the copied source or any real checkout.
  symlinkSync(join(candidate, 'node_modules'), join(old, 'node_modules'), 'dir');
  writeFileSync(join(old, 'package.json'), '{"type":"module"}\n', { flag: 'wx' });
  const driver = join(old, 'scripts', 'exploration-compatibility', 'legacy-consumer.ts');
  mkdirSync(dirname(driver), { recursive: true });
  cpSync(new URL('./exploration-compatibility/legacy-consumer.ts', import.meta.url), driver, {
    errorOnExist: true,
    force: false,
  });
  const path = join(scratch, 'synthetic-world.sqlite');
  const db = new DatabaseSync(path);
  const rejectionStderrPath = join(scratch, 'legacy-active-rejection.stderr.log');
  const rejectionStdoutPath = join(scratch, 'legacy-active-rejection.stdout.log');
  let oldActiveRejection:
    | { exitCode: number; error: string; stderrSha256: string; location: string }
    | undefined;
  function oldConsumer(
    operation: 'read' | 'reveal',
    x?: number,
    reject = false
  ): LegacyReceipt | undefined {
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', driver, operation, path, ...(x === undefined ? [] : [String(x)])],
      {
        cwd: old,
        encoding: 'utf8',
        timeout: 30_000,
        env: { ...process.env, SERVER_LOG_LEVEL: 'error' },
      }
    );
    if (result.error || result.signal) {
      throw new Error('Legacy consumer did not finish', { cause: result.error });
    }
    if (reject) {
      writeFileSync(rejectionStderrPath, result.stderr, {
        flag: 'wx',
        mode: 0o600,
      });
      writeFileSync(rejectionStdoutPath, result.stdout, {
        flag: 'wx',
        mode: 0o600,
      });
      const error = 'Saved world is invalid; refusing to replace player progress';
      assert.equal(result.status, 1, 'Expected the pinned legacy runtime rejection exit');
      assert.match(
        result.stderr,
        /Error: Saved world is invalid; refusing to replace player progress/u
      );
      assert.match(
        result.stderr,
        /at WorldStore\.loadWorld \([^\n]*server\/world\/WorldStore\.ts:238:\d+\)/u,
        'Only the actual pinned WorldStore.loadWorld rejection certifies active incompatibility'
      );
      oldActiveRejection = {
        exitCode: result.status,
        error,
        stderrSha256: createHash('sha256').update(result.stderr).digest('hex'),
        location: 'server/world/WorldStore.ts:238',
      };
      return undefined;
    }
    assert.equal(result.status, 0, result.stderr);
    return legacyReceipt(JSON.parse(result.stdout));
  }
  function transition(operation: 'prepare' | 'activate' | 'rollback'): void {
    transitionExplorationStorage(db, explorationStorageFingerprint(db), operation);
  }
  try {
    db.exec(
      readFileSync(
        new URL('../tests/fixtures/exploration-legacy-world.sql', import.meta.url),
        'utf8'
      )
    );
    const first = oldConsumer('reveal', 50_062.5);
    assert(first);
    const legacyJson = db.prepare('SELECT json FROM world').get();
    transition('prepare');
    assert.deepEqual(db.prepare('SELECT json FROM world').get(), legacyJson);
    assert.deepEqual(oldConsumer('read'), first);
    const latest = oldConsumer('reveal', 50_187.5);
    assert(latest);
    assert.equal(inspectExplorationStorage(db).state, 'stale-preparation');
    assert.throws(() => transition('activate'), /current prepared/u);
    transition('prepare');
    transition('activate');
    oldConsumer('read', undefined, true);
    assert(oldActiveRejection);
    const persistence = new WorkerWorldPersistence(path);
    const engine = new GameEngine(999, undefined, persistence);
    engine.revealArea({ x: 50_312.5, y: 62.5 }, 1);
    engine.revealArea({ x: -50_062.5, y: 62.5 }, 1);
    engine.checkpointWorld();
    await engine.whenPersistenceIdle();
    await engine.shutdownPersistence();
    const restarted = new WorldStore(path);
    let active: ExplorationTile[];
    try {
      active = restarted.load().exploration;
      assert(active.some((tile) => tile.id === '55,30' && tile.bits === `07${'00'.repeat(31)}`));
      assert(active.some((tile) => tile.id === '4,30' && tile.bits === `0080${'00'.repeat(30)}`));
    } finally {
      restarted.close();
    }
    transition('rollback');
    const rolledBack = oldConsumer('read');
    assert(rolledBack);
    assert.deepEqual(
      new Map(rolledBack.exploration.map(({ id, bits }) => [id, bits])),
      new Map(active.map(({ id, bits }) => [id, bits]))
    );
    assert.equal(rolledBack.progressDigest, latest.progressDigest);
    const receipt = {
      sourceSha256,
      legacyReadsAndWrites: true,
      stalePreparationRejected: true,
      oldActiveReaderRejected: true,
      oldActiveRejection,
      candidateWorkerRestart: true,
      rollbackLegacyReopen: true,
      progressDigest: latest.progressDigest,
      tiles: active.length,
    };
    writeFileSync(join(scratch, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
    process.stdout.write(`${JSON.stringify({ ...receipt, scratch })}\n`);
  } finally {
    db.close();
  }
}
