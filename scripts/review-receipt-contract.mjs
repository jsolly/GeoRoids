import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { validateIntegrationReport } from './code-integration-runner.mjs';
import { artifactRecord, reviewCommand, validateReviewReceipt } from './review-receipt.mjs';
import { reviewSourceIdentity } from './review-source-identity.mjs';

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'georoids-review-contract-')));
const root = join(scratch, 'repo');
const artifacts = join(scratch, 'artifacts');
const stage = join(artifacts, 'integration');
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const environment = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))
);
Object.assign(environment, { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' });
const json = (path, data) => writeFileSync(path, `${JSON.stringify(data)}\n`);
const helper = fileURLToPath(new URL('./review-receipt.mjs', import.meta.url));
function cli(...args) {
  return spawnSync(process.execPath, [helper, ...args], {
    cwd: root,
    env: environment,
    encoding: 'utf8',
  });
}
try {
  mkdirSync(join(root, 'tests/integration/server'), { recursive: true });
  mkdirSync(join(root, 'node_modules/vitest'), { recursive: true });
  mkdirSync(stage, { recursive: true });
  writeFileSync(join(root, '.gitignore'), 'node_modules/\n');
  const file = join(root, 'tests/integration/server/pilot.test.ts');
  writeFileSync(file, "test('pilot recovers', () => {});\n");
  const version = JSON.parse(
    readFileSync(new URL('../node_modules/vitest/package.json', import.meta.url), 'utf8')
  ).version;
  json(join(root, 'node_modules/vitest/package.json'), { version });
  assert.equal(spawnSync('git', ['init', '--quiet', root], { env: environment }).status, 0);
  const common = spawnSync(
    'git',
    ['-C', root, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
    { env: environment, encoding: 'utf8' }
  );
  assert.equal(common.status, 0);
  assert(common.stdout.trim().startsWith(`${scratch}/`));
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('GIT_')) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' });
  const source = reviewSourceIdentity(root);
  const discovery = [{ file, name: 'pilot recovers', location: { line: 1, column: 1 } }];
  const report = {
    success: true,
    numFailedTests: 0,
    numPendingTests: 0,
    numTodoTests: 0,
    numFailedTestSuites: 0,
    numPendingTestSuites: 0,
    numTotalTests: 1,
    numPassedTests: 1,
    testResults: [
      {
        name: file,
        status: 'passed',
        assertionResults: [
          {
            fullName: 'pilot recovers',
            status: 'passed',
            location: discovery[0].location,
            failureMessages: [],
          },
        ],
      },
    ],
  };
  const discoveryPath = join(stage, 'discovery.json'),
    reportPath = join(stage, 'vitest.json'),
    runnerPath = join(stage, 'runner.json');
  json(discoveryPath, discovery);
  json(reportPath, report);
  const runner = {
    schemaVersion: 1,
    mode: 'code-integration',
    worktree: root,
    sourceFingerprint: source,
    selectedFiles: [file],
    fullInventory: true,
    nodeVersion: process.version,
    vitestVersion: version,
    platform: process.platform,
    architecture: process.arch,
    reportPath,
    discoveryPath,
    success: true,
    validationSucceeded: true,
    cleanupSucceeded: true,
    timedOut: false,
    exitCode: 0,
    errors: [],
    reportSha256: digest(readFileSync(reportPath)),
    discoverySha256: digest(readFileSync(discoveryPath)),
    ...validateIntegrationReport(discovery, report, [file]),
  };
  json(runnerPath, runner);
  writeFileSync(join(stage, 'output.log'), 'retained console\n');
  assert.equal(cli('start', artifacts, root).status, 0);
  assert.equal(
    cli('stage', artifacts, 'integration', '0', ...reviewCommand('integration', artifacts)).status,
    0
  );
  assert.equal(cli('finish', artifacts, '0', 'true').status, 0);
  const path = join(artifacts, 'review.json');
  const original = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(validateReviewReceipt(path).success, true);
  const mutations = [
    { version: 1 },
    { success: false },
    { exitCode: 1 },
    { retentionSucceeded: false },
    { errors: ['failure'] },
    { stages: [] },
    { stages: [...original.stages, original.stages[0]] },
    { sourceIdentity: { ...source, sha256: 'wrong' } },
  ];
  for (const change of mutations) {
    json(path, { ...original, ...change });
    assert.throws(() => validateReviewReceipt(path));
  }
  json(path, original);
  for (const change of [
    { cleanupSucceeded: false },
    { timedOut: true },
    { fullInventory: false },
    { validationSucceeded: false },
    { nodeVersion: 'different' },
    { vitestVersion: 'different' },
  ]) {
    json(runnerPath, { ...runner, ...change });
    // Rehash the retained wrapper to reach semantic validation, beyond tamper checks.
    const candidate = structuredClone(original);
    candidate.stages[0].artifacts = candidate.stages[0].artifacts.map((row) =>
      row.path === runnerPath ? artifactRecord(runnerPath) : row
    );
    json(path, candidate);
    assert.throws(() => validateReviewReceipt(path));
  }
  json(runnerPath, runner);
  json(path, original);
  writeFileSync(join(stage, 'output.log'), 'changed console');
  assert.throws(() => validateReviewReceipt(path), /Retained artifact changed/u);
  writeFileSync(join(stage, 'output.log'), 'retained console\n');
  writeFileSync(file, 'changed source\n');
  assert.throws(() => validateReviewReceipt(path), /Review source changed/u);
  assert.equal(validateReviewReceipt(path, { checkCurrentSource: false }).success, true);
  writeFileSync(file, "test('pilot recovers', () => {});\n");
  symlinkSync(join(stage, 'output.log'), join(stage, 'alias'));
  assert.throws(() => validateReviewReceipt(path), /refuses symlinks/u);
  rmSync(join(stage, 'alias'));
  assert.equal(cli('start', artifacts, root).status, 0);
  assert.notEqual(cli('finish', artifacts, '1', 'false').status, 0);
  const failed = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(failed.success, false);
  assert.equal(failed.retentionSucceeded, false);
  assert(failed.errors.length > 0);
  process.stdout.write(
    'Review receipt contracts passed: full code evidence, fail-closed mutation, retention, source/runtime identity and historical validation.\n'
  );
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
