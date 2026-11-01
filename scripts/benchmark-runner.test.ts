import assert from 'node:assert/strict';
import { type SpawnSyncReturns, spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { type TestContext, test } from 'vitest';

const source = dirname(fileURLToPath(import.meta.url));
interface EventRow extends Record<string, unknown> {
  kind: string;
}
interface Fixture {
  root: string;
  run: (args: readonly string[], extras?: NodeJS.ProcessEnv) => SpawnSyncReturns<string>;
  records: () => EventRow[];
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isEventRow(value: unknown): value is EventRow {
  return isRecord(value) && typeof value['kind'] === 'string';
}
function argumentsOf(row: EventRow | undefined): readonly string[] {
  assert(row !== undefined);
  const args = row['args'];
  assert(
    Array.isArray(args) &&
      args.every((value: unknown): value is string => typeof value === 'string')
  );
  return args;
}
function receiptAt(root: string): Record<string, unknown> {
  const receipt: unknown = JSON.parse(readFileSync(join(root, 'runner.json'), 'utf8'));
  assert(isRecord(receipt));
  return receipt;
}

function fixture(t: TestContext): Fixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'manual-benchmark-contract-')));
  t.onTestFinished(() => {
    if (
      existsSync(join(root, '.git/georoids-validation-checkout.lock')) ||
      existsSync(join(root, '.git/georoids-test-runner.lock'))
    ) {
      console.info(`Unproven fixture cleanup retained at ${root}`);
      return;
    }
    rmSync(root, { recursive: true, force: true });
  });
  const scripts = join(root, 'scripts'),
    bin = join(root, 'bin');
  mkdirSync(scripts);
  mkdirSync(bin);
  for (const name of [
    'test-runner.sh',
    'benchmark-runner.sh',
    'process-tree.sh',
    'test-runner-ports.sh',
    'test-ports.mjs',
    'validation-admission.mjs',
    'benchmark-build-receipt.mjs',
    'client-asset-graph.js',
  ]) {
    cpSync(join(source, name), join(scripts, name));
  }
  writeFileSync(
    join(scripts, 'review-receipt.mjs'),
    readFileSync(join(source, 'benchmark-runner-fixture-receipt.mjs'))
  );
  mkdirSync(join(root, 'config/app'), { recursive: true });
  writeFileSync(join(root, 'config/app/.env.example'), '');
  writeFileSync(join(root, 'package-lock.json'), '{"lockfileVersion":3}');
  const recordsPath = join(root, 'records');
  const env: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.startsWith('GIT_') && !key.startsWith('GEOROIDS_')
    )
  );
  Object.assign(env, {
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    PATH: `${bin}:${env['PATH']}`,
    BENCHMARK_RECORDS: recordsPath,
    GEOROIDS_TEST_MAX_DURATION_SECONDS: '10',
    GEOROIDS_TEST_RUNNER_RECEIPT: join(root, 'runner.json'),
  });
  const git = (...args: string[]): void => {
    const result = spawnSync('git', ['-C', root, ...args], { env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };
  git('init', '-q');
  git(
    '-c',
    'core.hooksPath=/dev/null',
    '-c',
    'user.name=fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '--allow-empty',
    '-qm',
    'fixture'
  );
  function executable(name: string, contents: string | Uint8Array): void {
    writeFileSync(join(bin, name), contents, { mode: 0o755 });
  }
  executable('curl', '#!/bin/sh\nexit 0\n');
  executable(
    'lsof',
    '#!/bin/sh\nif [ -s "$BENCHMARK_RECORDS.pid" ]; then cat "$BENCHMARK_RECORDS.pid"; else exit 1; fi\n'
  );
  executable('npm', readFileSync(join(source, 'benchmark-runner-fixture-npm.cjs')));
  executable('npx', readFileSync(join(source, 'benchmark-runner-fixture-npx.cjs')));
  function run(args: readonly string[], extras: NodeJS.ProcessEnv = {}): SpawnSyncReturns<string> {
    return spawnSync('bash', [join(scripts, 'test-runner.sh'), ...args], {
      cwd: root,
      env: { ...env, ...extras },
      encoding: 'utf8',
      timeout: 20000,
    });
  }
  function records(): EventRow[] {
    return existsSync(recordsPath)
      ? readFileSync(recordsPath, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => {
            const row: unknown = JSON.parse(line);
            assert(isEventRow(row));
            return row;
          })
      : [];
  }
  return { root, run, records };
}

test('manual load measurements retain their services until the owned measurement finishes, then prove cleanup', (t) => {
  const f = fixture(t),
    result = f.run(['--benchmark-load', '--scenario', 'traversal', '--seed', '42']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const records = f.records();
  assert.deepEqual(
    records.map((row) => row.kind),
    ['build', 'services', 'measurement', 'services-closed']
  );
  assert(argumentsOf(records[1]).some((arg) => arg.includes('benchmarks/realtime-server.ts')));
  assert(argumentsOf(records[2]).includes('benchmarks/load.ts'));
  const receipt = receiptAt(f.root);
  assert.equal(receipt['cleanupSucceeded'], true);
  assert.equal(receipt['lockReleased'], true);
  assert.equal(receipt['sessionRemoved'], true);
  assert.equal(existsSync(join(f.root, '.git/georoids-test-runner.lock')), false);
  assert.equal(existsSync(join(f.root, '.git/georoids-validation-checkout.lock')), false);
});
test('a failed production build starts no manual service or measurement and releases proven ownership', (t) => {
  const f = fixture(t),
    result = f.run(['--benchmark-load'], { FAIL_BUILD: '1' });
  assert.notEqual(result.status, 0);
  assert.deepEqual(
    f.records().map((row) => row.kind),
    ['build']
  );
  assert.equal(receiptAt(f.root)['cleanupSucceeded'], true);
  assert.equal(existsSync(join(f.root, '.git/georoids-validation-checkout.lock')), false);
});
test('frozen client reuse without a valid build receipt starts no services and performs no replacement build', (t) => {
  const f = fixture(t),
    result = f.run(['--benchmark-client', '--reuse-build']);
  assert.notEqual(result.status, 0);
  assert.deepEqual(f.records(), []);
  assert.equal(existsSync(join(f.root, '.git/georoids-validation-checkout.lock')), false);
});
