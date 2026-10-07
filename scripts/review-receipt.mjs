import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { validateCodeIntegrationReceipt } from './code-integration-runner.mjs';
import { reviewSourceIdentity } from './review-source-identity.mjs';

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const digest = (value) => createHash('sha256').update(value).digest('hex');
export function reviewCommand(name, directory) {
  assert.equal(name, 'integration', 'Unknown review stage');
  return [
    'env',
    `GEOROIDS_CODE_INTEGRATION_RECEIPT=${join(directory, 'integration/runner.json')}`,
    './scripts/test-runner.sh',
    '--reporter=verbose',
  ];
}
function atomicJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}
export function artifactRecord(path) {
  assert(isAbsolute(path), 'Artifact path must be absolute');
  const info = lstatSync(path);
  assert(info.isFile() && !info.isSymbolicLink(), `Artifact is not a regular file: ${path}`);
  return { path, bytes: info.size, sha256: digest(readFileSync(path)) };
}
function artifactsIn(directory, excluded = []) {
  const rows = [];
  for (const item of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name)
  )) {
    if (excluded.includes(item.name)) {
      continue;
    }
    const path = join(directory, item.name);
    assert(!item.isSymbolicLink(), `Artifact retention refuses symlinks: ${path}`);
    if (item.isDirectory()) {
      rows.push(...artifactsIn(path, excluded));
    } else {
      assert(item.isFile(), `Unsupported retained artifact: ${path}`);
      rows.push(artifactRecord(path));
    }
  }
  return rows;
}
function validateArtifacts(rows) {
  assert(Array.isArray(rows) && rows.length > 0, 'Missing retained artifact digests');
  const paths = new Set();
  for (const row of rows) {
    assert(!paths.has(row.path), 'Duplicate retained artifact');
    paths.add(row.path);
    assert.deepEqual(artifactRecord(row.path), row, `Retained artifact changed: ${row.path}`);
  }
}

function validateStage(row, receipt, checkCurrentSource = true) {
  assert.equal(row.name, 'integration');
  assert.equal(row.exitCode, 0);
  assert.equal(row.success, true);
  assert.deepEqual(row.command, reviewCommand(row.name, receipt.artifactDirectory));
  const home = join(receipt.artifactDirectory, 'integration');
  validateArtifacts(row.artifacts);
  assert.deepEqual(row.artifacts, artifactsIn(home), 'Stage artifact inventory differs');
  assert(
    row.artifacts.some((item) => item.path === join(home, 'output.log')),
    'Missing console retention'
  );
  const integration = validateCodeIntegrationReceipt(join(home, 'runner.json'), {
    checkCurrentSource,
    requireFullInventory: true,
  });
  assert.equal(integration.worktree, receipt.worktree, 'Integration worktree differs');
  assert.deepEqual(
    integration.sourceFingerprint,
    receipt.sourceIdentity,
    'Integration review source differs'
  );
}
export function validateReviewReceipt(path, { checkCurrentSource = true } = {}) {
  const receipt = readJson(path);
  assert.equal(receipt.version, 2);
  assert.equal(receipt.kind, 'georoids-review');
  assert.equal(receipt.success, true);
  assert.equal(receipt.exitCode, 0);
  assert.equal(receipt.retentionSucceeded, true);
  assert.deepEqual(receipt.errors, []);
  assert(isAbsolute(receipt.worktree) && realpathSync(receipt.worktree) === receipt.worktree);
  assert(
    isAbsolute(receipt.artifactDirectory) &&
      realpathSync(receipt.artifactDirectory) === receipt.artifactDirectory
  );
  assert.deepEqual(
    receipt.stages.map((row) => row.name),
    ['integration']
  );
  assert(Array.isArray(receipt.sourceIdentity.files));
  assert.equal(digest(JSON.stringify(receipt.sourceIdentity.files)), receipt.sourceIdentity.sha256);
  if (checkCurrentSource) {
    assert.deepEqual(
      reviewSourceIdentity(receipt.worktree),
      receipt.sourceIdentity,
      'Review source changed'
    );
  }
  for (const row of receipt.stages) {
    validateStage(row, receipt, checkCurrentSource);
  }
  return receipt;
}
function main([action, ...args]) {
  if (action === 'runner') {
    const [
      home,
      destination,
      mode,
      root,
      pid,
      startedAt,
      code,
      cleanup,
      timedOut,
      lockHeld,
      session,
      signal,
    ] = args;
    const success =
      Number(code) === 0 &&
      cleanup === 'true' &&
      timedOut === 'false' &&
      lockHeld === 'false' &&
      (!session || !existsSync(session)) &&
      !signal;
    const receipt = {
      version: 1,
      kind: 'georoids-runner-final',
      runId: randomUUID(),
      worktree: realpathSync(root),
      mode,
      ownerPid: Number(pid),
      startedAt: Number(startedAt),
      finishedAt: Date.now(),
      exitCode: Number(code),
      cleanupSucceeded: cleanup === 'true',
      timedOut: timedOut === 'true',
      lockReleased: lockHeld === 'false',
      sessionRemoved: !session || !existsSync(session),
      signal,
      success,
      artifactDirectory: home || null,
      artifacts: home ? artifactsIn(home, ['runner.json']) : [],
    };
    if (home) {
      atomicJson(join(home, 'runner.json'), receipt);
    }
    if (destination) {
      atomicJson(destination, receipt);
    }
    return;
  }

  const [directory, value] = args;
  const statePath = join(directory, 'state.json');
  if (action === 'start') {
    atomicJson(statePath, {
      version: 2,
      kind: 'georoids-review',
      runId: randomUUID(),
      worktree: realpathSync(value),
      artifactDirectory: realpathSync(directory),
      sourceIdentity: reviewSourceIdentity(value),
      stages: [],
      errors: [],
    });
  } else if (action === 'stage') {
    const receipt = readJson(statePath);
    assert.equal(receipt.stages.length, 0, 'Unexpected repeated review stage');
    const row = {
      name: value,
      command: args.slice(3),
      exitCode: Number(args[2]),
      success: Number(args[2]) === 0,
      artifacts: artifactsIn(join(directory, value)),
    };
    validateStage(row, receipt);
    receipt.stages.push(row);
    atomicJson(statePath, receipt);
  } else if (action === 'finish') {
    const receipt = readJson(statePath);
    receipt.exitCode = Number(value);
    receipt.retentionSucceeded = args[2] === 'true';
    receipt.success = receipt.exitCode === 0 && receipt.retentionSucceeded;
    const destination = args[3] || join(directory, 'review.json');
    try {
      assert(receipt.success, 'Review command or retention failed');
      assert.deepEqual(
        receipt.stages.map((row) => row.name),
        ['integration']
      );
      assert.deepEqual(
        reviewSourceIdentity(receipt.worktree),
        receipt.sourceIdentity,
        'Source changed during review'
      );
      for (const row of receipt.stages) {
        validateStage(row, receipt);
      }
    } catch (error) {
      receipt.success = false;
      receipt.exitCode ||= 1;
      receipt.errors.push(String(error));
    }
    receipt.finishedAt = Date.now();
    atomicJson(join(directory, 'review.json'), receipt);
    if (resolve(destination) !== join(directory, 'review.json')) {
      atomicJson(destination, receipt);
    }
    assert(receipt.success, receipt.errors.join('\n'));
  } else if (action === 'validate') {
    validateReviewReceipt(directory);
  } else {
    throw new Error('Expected start, stage, finish, runner or validate');
  }
}
if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.stack ?? error}\n`);
    process.exitCode = 1;
  }
}
