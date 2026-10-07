import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { reviewSourceIdentity } from './review-source-identity.mjs';
import { runAdmitted, verifyChild } from './validation-admission.mjs';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const serial = [
  '--config=vitest.config.ts',
  '--configLoader=runner',
  '--pool=forks',
  '--maxWorkers=1',
  '--sequence.concurrent=false',
  '--maxConcurrency=1',
  '--isolate=true',
  '--fileParallelism=false',
];

export function integrationFiles(root) {
  const files = [];
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else if (entry.isFile() && /\.(?:test|spec)\.ts$/u.test(entry.name)) {
        files.push(resolve(path));
      }
    }
  }
  for (const directory of ['server', 'entities']) {
    const home = join(root, 'tests/integration', directory);
    if (existsSync(home)) {
      visit(home);
    }
  }
  assert(files.length > 0, 'No code integration files exist');
  return files.sort();
}

export function selectIntegration(root, args) {
  const inventory = integrationFiles(root);
  const selectors = [];
  const reporters = [];
  const options = args.values();
  for (const arg of options) {
    if (arg === '--reporter') {
      const value = options.next().value;
      assert(
        ['verbose', 'dot', 'default', 'json'].includes(value),
        'Unsupported integration reporter'
      );
      reporters.push(`--reporter=${value}`);
    } else if (arg.startsWith('--reporter=')) {
      assert(
        ['verbose', 'dot', 'default', 'json'].includes(arg.slice(11)),
        'Unsupported integration reporter'
      );
      reporters.push(arg);
    } else {
      assert(!arg.startsWith('-'), `Unsupported or protected integration option: ${arg}`);
      const path = resolve(root, arg);
      const relativePath = relative(root, path);
      assert(
        relativePath === 'tests/integration' ||
          /^(?:tests\/integration\/(?:server|entities))(?:\/|$)/u.test(relativePath),
        `Integration selector is outside code tests: ${arg}`
      );
      assert(existsSync(path), `Explicit integration selector does not exist: ${arg}`);
      const matches = inventory.filter((file) => file === path || file.startsWith(`${path}/`));
      assert(matches.length > 0, `Integration selector contains no tests: ${arg}`);
      selectors.push(...matches);
    }
  }
  const files = selectors.length ? [...new Set(selectors)].sort() : inventory;
  return { files, reporters, fullInventory: JSON.stringify(files) === JSON.stringify(inventory) };
}

function keys(rows) {
  const occurrences = new Map();
  return rows
    .map((row) => {
      assert(
        typeof row.name === 'string' &&
          row.name.length > 0 &&
          row.location &&
          Number.isInteger(row.location.line) &&
          Number.isInteger(row.location.column),
        'Missing integration case identity'
      );
      const base = JSON.stringify([
        resolve(row.file),
        row.name.replaceAll(' > ', ' '),
        row.location.line,
        row.location.column,
      ]);
      const occurrence = (occurrences.get(base) ?? 0) + 1;
      occurrences.set(base, occurrence);
      return `${base}#${occurrence}`;
    })
    .sort();
}

export function validateIntegrationReport(discovery, report, selectedFiles) {
  assert(Array.isArray(discovery) && discovery.length > 0, 'Missing discovered integration cases');
  assert.deepEqual(
    [...new Set(discovery.map((row) => resolve(row.file)))].sort(),
    selectedFiles,
    'Discovery differs from selected integration files'
  );
  assert.equal(report.success, true, 'Integration report is unsuccessful');
  for (const field of [
    'numFailedTests',
    'numPendingTests',
    'numTodoTests',
    'numFailedTestSuites',
    'numPendingTestSuites',
  ]) {
    assert.equal(report[field], 0, `Integration report contains ${field}`);
  }
  assert(
    Array.isArray(report.testResults) && report.testResults.length > 0,
    'Missing integration file results'
  );
  const files = [];
  const cases = [];
  for (const result of report.testResults) {
    assert.equal(result.status, 'passed', `Incomplete integration file: ${result.name}`);
    assert(
      Array.isArray(result.assertionResults) && result.assertionResults.length > 0,
      'Missing integration assertions'
    );
    files.push(resolve(result.name));
    for (const row of result.assertionResults) {
      assert.equal(
        row.status,
        'passed',
        `Failed, skipped or pending integration case: ${row.fullName}`
      );
      assert.deepEqual(row.failureMessages, [], 'Integration case retains a failure');
      cases.push({ file: resolve(result.name), name: row.fullName, location: row.location });
    }
  }
  assert.deepEqual(
    files.sort(),
    selectedFiles,
    'Missing, duplicated or unexpected integration files'
  );
  assert.deepEqual(
    keys(cases),
    keys(discovery),
    'Missing, duplicated or changed integration cases'
  );
  assert.equal(report.numTotalTests, cases.length, 'Integration total differs from case evidence');
  assert.equal(
    report.numPassedTests,
    cases.length,
    'Integration passed count differs from case evidence'
  );
  return { fileCount: files.length, caseCount: cases.length, caseIdentities: keys(cases) };
}

export function validateCodeIntegrationReceipt(
  path,
  { checkCurrentSource = true, requireFullInventory = true } = {}
) {
  const receipt = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(receipt.schemaVersion, 1, 'Unsupported code integration receipt');
  assert.equal(receipt.mode, 'code-integration', 'Not a code integration receipt');
  assert(
    Array.isArray(receipt.sourceFingerprint?.files) && receipt.sourceFingerprint.files.length > 0,
    'Missing code integration source inventory'
  );
  assert.equal(
    receipt.sourceFingerprint.sha256,
    digest(JSON.stringify(receipt.sourceFingerprint.files)),
    'Invalid code integration source fingerprint'
  );
  assert(
    typeof receipt.nodeVersion === 'string' &&
      typeof receipt.vitestVersion === 'string' &&
      typeof receipt.platform === 'string' &&
      typeof receipt.architecture === 'string',
    'Missing code integration runtime'
  );
  assert.equal(receipt.success, true, 'Code integration did not pass');
  assert.equal(receipt.validationSucceeded, true, 'Code integration was not validated');
  assert.equal(receipt.exitCode, 0, 'Code integration command failed');
  assert.equal(receipt.cleanupSucceeded, true, 'Code integration cleanup is unproven');
  assert.equal(receipt.timedOut, false, 'Code integration timed out');
  assert.deepEqual(receipt.errors, [], 'Code integration errors');
  assert(
    isAbsolute(receipt.worktree) && Array.isArray(receipt.selectedFiles),
    'Invalid code integration worktree or inventory'
  );
  assert(
    isAbsolute(receipt.reportPath) && isAbsolute(receipt.discoveryPath),
    'Invalid code integration artifact paths'
  );
  assert.equal(
    receipt.reportSha256,
    digest(readFileSync(receipt.reportPath)),
    'Changed code integration report'
  );
  assert.equal(
    receipt.discoverySha256,
    digest(readFileSync(receipt.discoveryPath)),
    'Changed code integration discovery'
  );
  const actual = validateIntegrationReport(
    JSON.parse(readFileSync(receipt.discoveryPath, 'utf8')),
    JSON.parse(readFileSync(receipt.reportPath, 'utf8')),
    receipt.selectedFiles
  );
  assert.equal(receipt.fileCount, actual.fileCount, 'Receipt file count differs');
  assert.equal(receipt.caseCount, actual.caseCount, 'Receipt case count differs');
  assert.deepEqual(receipt.caseIdentities, actual.caseIdentities, 'Receipt case identities differ');
  if (requireFullInventory) {
    assert.equal(receipt.fullInventory, true, 'Partial integration cannot certify a full review');
    if (checkCurrentSource) {
      assert.deepEqual(
        receipt.selectedFiles,
        integrationFiles(receipt.worktree),
        'Full integration inventory changed'
      );
    }
  }
  if (checkCurrentSource) {
    assert.deepEqual(
      receipt.sourceFingerprint,
      reviewSourceIdentity(receipt.worktree),
      'Code integration source changed'
    );
    assert.equal(receipt.nodeVersion, process.version, 'Code integration Node changed');
    assert.equal(receipt.platform, process.platform, 'Code integration platform changed');
    assert.equal(receipt.architecture, process.arch, 'Code integration architecture changed');
    assert.equal(
      receipt.vitestVersion,
      JSON.parse(readFileSync(join(receipt.worktree, 'node_modules/vitest/package.json'), 'utf8'))
        .version,
      'Code integration Vitest changed'
    );
  }
  return receipt;
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}
async function vitest(root, command, output) {
  return await new Promise((accept, reject) => {
    const child = spawn(
      process.execPath,
      [join(root, 'node_modules/vitest/vitest.mjs'), ...command],
      { cwd: root, stdio: 'inherit', env: { ...process.env, VITEST_MAX_WORKERS: '1' } }
    );
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (signal) {
        reject(new Error(`Integration ${output} exited from ${signal}`));
      } else {
        accept(code ?? 1);
      }
    });
  });
}
async function issued(root, receiptPath, args) {
  verifyChild(root, 'integration');
  const selection = selectIntegration(root, args);
  const directory = dirname(receiptPath);
  mkdirSync(directory, { recursive: true });
  process.env.GEOROIDS_TEST_SESSION_DIR = directory;
  process.env.GEOROIDS_TEST_LOG_DIR = join(directory, 'logs');
  process.env.TMPDIR = join(directory, 'tmp');
  mkdirSync(process.env.TMPDIR, { recursive: true });
  const sourceFingerprint = reviewSourceIdentity(root);
  const discoveryPath = join(directory, 'discovery.json');
  const reportPath = join(directory, 'vitest.json');
  const receipt = {
    schemaVersion: 1,
    vitestVersion: JSON.parse(readFileSync(join(root, 'node_modules/vitest/package.json'), 'utf8'))
      .version,
    mode: 'code-integration',
    worktree: realpathSync(root),
    sourceFingerprint,
    selectedFiles: selection.files,
    fullInventory: selection.fullInventory,
    nodeVersion: process.version,
    platform: process.platform,
    architecture: process.arch,
    reportPath,
    discoveryPath,
    success: false,
    cleanupSucceeded: false,
    timedOut: false,
    exitCode: 1,
    errors: [],
  };
  writeJson(receiptPath, receipt);
  try {
    const listed = await vitest(
      root,
      ['list', '--staticParse=false', ...serial, ...selection.files, `--json=${discoveryPath}`],
      'discovery'
    );
    assert.equal(listed, 0, 'Integration discovery failed');
    const discovery = JSON.parse(readFileSync(discoveryPath, 'utf8'));
    assert.deepEqual(
      [...new Set(discovery.map((row) => resolve(row.file)))].sort(),
      selection.files,
      'Discovery omitted selected integration files'
    );
    const exitCode = await vitest(
      root,
      [
        'run',
        ...serial,
        ...selection.files,
        ...selection.reporters.filter((r) => r !== '--reporter=json'),
        '--reporter=json',
        `--outputFile.json=${reportPath}`,
      ],
      'tests'
    );
    receipt.exitCode = exitCode;
    receipt.reportSha256 = digest(readFileSync(reportPath));
    receipt.discoverySha256 = digest(readFileSync(discoveryPath));
    Object.assign(
      receipt,
      validateIntegrationReport(
        discovery,
        JSON.parse(readFileSync(reportPath, 'utf8')),
        selection.files
      )
    );
    assert.equal(exitCode, 0, 'Integration command failed');
    assert.deepEqual(
      reviewSourceIdentity(root),
      sourceFingerprint,
      'Integration source changed during validation'
    );
    receipt.validationSucceeded = true;
  } catch (error) {
    receipt.errors.push(String(error));
    receipt.exitCode = receipt.exitCode || 1;
  }
  writeJson(receiptPath, receipt);
  return receipt.validationSucceeded === true ? 0 : receipt.exitCode;
}
async function main(args) {
  const root = realpathSync(process.cwd());
  if (args[0] === '--issued') {
    return issued(root, args[1], args.slice(2));
  }
  selectIntegration(root, args);
  const seconds = process.env.GEOROIDS_TEST_MAX_DURATION_SECONDS ?? '1200';
  assert(
    /^[1-9]\d*$/u.test(seconds) && Number.isSafeInteger(Number(seconds) * 1000),
    'Invalid integration deadline'
  );
  const receiptPath =
    process.env.GEOROIDS_CODE_INTEGRATION_RECEIPT ??
    join(root, '.performance/code-integration', `run-${randomUUID()}`, 'runner.json');
  assert(isAbsolute(receiptPath), 'Code integration receipt path must be absolute');
  for (const path of [
    receiptPath,
    join(dirname(receiptPath), 'discovery.json'),
    join(dirname(receiptPath), 'vitest.json'),
  ]) {
    assert(!existsSync(path), `Code integration artifact already exists: ${path}`);
  }
  const start = Date.now();
  const code = await runAdmitted(
    'integration',
    [process.execPath, fileURLToPath(import.meta.url), '--issued', receiptPath, ...args],
    { root, timeoutMs: Number(seconds) * 1000 }
  );
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
  receipt.exitCode = code;
  receipt.cleanupSucceeded = true;
  receipt.timedOut = code === 124;
  receipt.elapsedMs = Date.now() - start;
  receipt.success =
    code === 0 && receipt.validationSucceeded === true && receipt.errors.length === 0;
  writeJson(receiptPath, receipt);
  process.stdout.write(`Code integration receipt: ${receiptPath}\n`);
  return receipt.success ? 0 : code || 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.stack}\n`);
    process.exitCode = 1;
  }
}
