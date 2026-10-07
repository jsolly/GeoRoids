import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import test from 'node:test';
import {
  selectIntegration,
  validateCodeIntegrationReceipt,
  validateIntegrationReport,
} from './code-integration-runner.mjs';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'code-integration-contract-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const files = ['server/one.test.ts', 'entities/input/two.test.ts']
    .map((path) => join(root, 'tests/integration', path))
    .sort((a, b) => a.localeCompare(b));
  for (const path of files) {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, '// code test\n');
  }
  const discovery = files.map((file, index) => ({
    file,
    name: `pilot ${index} recovers`,
    location: { line: 2, column: 1 },
  }));
  const report = {
    success: true,
    numFailedTests: 0,
    numPendingTests: 0,
    numTodoTests: 0,
    numFailedTestSuites: 0,
    numPendingTestSuites: 0,
    numTotalTests: 2,
    numPassedTests: 2,
    testResults: discovery.map((row) => ({
      name: row.file,
      status: 'passed',
      assertionResults: [
        { fullName: row.name, status: 'passed', location: row.location, failureMessages: [] },
      ],
    })),
  };
  return { root, files, discovery, report };
}
test('complete code discovery includes both server and entity tests and refuses omitted selectors', (t) => {
  const f = fixture(t);
  assert.deepEqual(selectIntegration(f.root, []).files, f.files);
  assert.equal(
    selectIntegration(f.root, ['tests/integration', '--reporter=verbose']).fullInventory,
    true
  );
  assert.equal(selectIntegration(f.root, ['tests/integration/server']).fullInventory, false);
  for (const selection of [
    'tests/integration/server/missing.test.ts',
    'tests/integration/browser',
    '--testNamePattern=easy',
    '--exclude=hard',
    '--shard=1/2',
    '--pool=threads',
    '--testTimeout=999999',
    '--',
  ]) {
    assert.throws(() => selectIntegration(f.root, [selection]));
  }
});
test('exact code-case parity rejects skipped, missing, duplicated and changed passing reports', (t) => {
  const f = fixture(t);
  assert.equal(validateIntegrationReport(f.discovery, f.report, f.files).caseCount, 2);
  const mutations = [
    (r) => {
      r.numPendingTests = 1;
    },
    (r) => {
      r.numTodoTests = 1;
    },
    (r) => {
      r.testResults.pop();
    },
    (r) => {
      r.testResults.push(r.testResults[0]);
    },
    (r) => {
      r.testResults[0].assertionResults[0].status = 'pending';
    },
    (r) => {
      r.testResults[0].assertionResults[0].fullName = 'unrelated case';
    },
    (r) => {
      r.testResults[0].assertionResults[0].location.line++;
    },
    (r) => {
      r.numPassedTests = 1;
    },
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(f.report);
    mutate(changed);
    assert.throws(() => validateIntegrationReport(f.discovery, changed, f.files));
  }
});
test('a cleanup-bound full receipt rejects altered artifacts and partial validation', (t) => {
  const f = fixture(t);
  const reportPath = join(f.root, 'report.json'),
    discoveryPath = join(f.root, 'discovery.json'),
    path = join(f.root, 'receipt.json');
  writeFileSync(reportPath, JSON.stringify(f.report));
  writeFileSync(discoveryPath, JSON.stringify(f.discovery));
  const files = [{ file: 'scenario.ts', sha256: digest('source') }];
  const receipt = {
    schemaVersion: 1,
    mode: 'code-integration',
    worktree: f.root,
    sourceFingerprint: { files, sha256: digest(JSON.stringify(files)) },
    success: true,
    validationSucceeded: true,
    cleanupSucceeded: true,
    timedOut: false,
    exitCode: 0,
    errors: [],
    fullInventory: true,
    selectedFiles: f.files,
    reportPath,
    discoveryPath,
    reportSha256: digest(readFileSync(reportPath)),
    discoverySha256: digest(readFileSync(discoveryPath)),
    nodeVersion: process.version,
    vitestVersion: '5.0.1',
    platform: process.platform,
    architecture: process.arch,
    ...validateIntegrationReport(f.discovery, f.report, f.files),
  };
  const check = () => validateCodeIntegrationReceipt(path, { checkCurrentSource: false });
  writeFileSync(path, JSON.stringify(receipt));
  assert.equal(check().caseCount, 2);
  for (const mutation of [
    { cleanupSucceeded: false },
    { timedOut: true },
    { fullInventory: false },
    { caseCount: 1 },
  ]) {
    writeFileSync(path, JSON.stringify({ ...receipt, ...mutation }));
    assert.throws(check);
  }
  writeFileSync(path, JSON.stringify(receipt));
  writeFileSync(reportPath, '{}');
  assert.throws(check, /Changed code integration report/u);
});

test('review source inventory ignores inherited Git directory, worktree and index redirection', (t) => {
  const f = fixture(t);
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))
  );
  Object.assign(env, { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' });
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: f.root, env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };
  git('init', '-q');
  const probe = `const {reviewSourceIdentity} = await import(${JSON.stringify(new URL('./review-source-identity.mjs', import.meta.url).href)}); process.stdout.write(JSON.stringify(reviewSourceIdentity(${JSON.stringify(f.root)})));`;
  const expected = spawnSync(process.execPath, ['--input-type=module', '-e', probe], {
    env,
    encoding: 'utf8',
  });
  assert.equal(expected.status, 0, expected.stderr);
  const hostile = spawnSync(process.execPath, ['--input-type=module', '-e', probe], {
    env: {
      ...env,
      GIT_DIR: '/missing/foreign.git',
      GIT_WORK_TREE: '/missing/foreign-root',
      GIT_INDEX_FILE: '/missing/foreign-index',
    },
    encoding: 'utf8',
  });
  assert.equal(hostile.status, 0, hostile.stderr);
  assert.deepEqual(JSON.parse(hostile.stdout), JSON.parse(expected.stdout));
});
