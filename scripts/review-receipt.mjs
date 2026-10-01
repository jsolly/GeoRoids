import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const digest = (value) => createHash('sha256').update(value).digest('hex');
const stages = ['integration', 'frame', 'traversal', 'combat'];
export function reviewCommand(name, directory) {
  const outputs = {
    frame: 'frame-work.json',
    traversal: 'mobile-combined.json',
    combat: 'mobile-combat.json',
  };
  if (name === 'integration') {
    return [
      'env',
      `GEOROIDS_TEST_SHARD_RECEIPT=${join(directory, 'integration/shards.json')}`,
      './scripts/test-runner.sh',
      '--shards=6',
      'tests/integration/',
      '--reporter=verbose',
    ];
  }
  if (name === 'frame') {
    return [
      'node',
      '--import',
      'tsx',
      'scripts/measure-frame-work.ts',
      '--budget',
      'docs/performance/frame-work-budget.json',
      '--output',
      join(directory, outputs.frame),
    ];
  }
  assert(stages.includes(name), 'Unknown review stage');
  return [
    'env',
    'GEOROIDS_TEST_MAX_DURATION_SECONDS=240',
    './scripts/test-runner.sh',
    '--benchmark-client',
    '--viewport',
    'touch-portrait',
    '--dpr',
    '3',
    '--cpu-slowdown',
    name === 'traversal' ? '4' : '1',
    '--network',
    name === 'traversal' ? 'normal' : 'clean',
    '--scenario',
    name,
    '--seed',
    '42',
    '--warmup',
    '5',
    '--seconds',
    '15',
    '--output',
    join(directory, outputs[name]),
  ];
}

export function reviewSourceIdentity(root) {
  const inventory = spawnSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { cwd: root, encoding: 'utf8' }
  );
  assert.equal(inventory.status, 0, 'Cannot inventory review source');
  const files = [
    ...new Set(
      inventory.stdout
        .split('\0')
        .filter((file) => file && !/^(?:\.performance|logs|node_modules)\//u.test(file))
    ),
  ].sort();
  const rows = files.map((file) => {
    const path = join(root, file);
    if (!existsSync(path) && !lstatExists(path)) {
      return { file, deleted: true };
    }
    const info = lstatSync(path);
    assert(info.isFile() || info.isSymbolicLink(), `Unsupported review source: ${file}`);
    return {
      file,
      mode: info.mode & 0o777,
      kind: info.isSymbolicLink() ? 'symlink' : 'file',
      sha256: digest(info.isSymbolicLink() ? readlinkSync(path) : readFileSync(path)),
    };
  });
  return { sha256: digest(JSON.stringify(rows)), files: rows };
}
function lstatExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
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
function validateRunner(path, root, mode) {
  const receipt = readJson(path);
  assert.equal(receipt.version, 1);
  assert.equal(receipt.kind, 'georoids-runner-final');
  assert.equal(receipt.worktree, root);
  assert.equal(receipt.mode, mode);
  assert.equal(receipt.exitCode, 0);
  assert.equal(receipt.success, true);
  assert.equal(receipt.cleanupSucceeded, true);
  assert.equal(receipt.lockReleased, true);
  assert.equal(receipt.sessionRemoved, true);
  assert.equal(receipt.timedOut, false);
  assert.equal(receipt.signal, '');
  assert(Number.isInteger(receipt.ownerPid) && receipt.ownerPid > 0);
  assert(typeof receipt.runId === 'string' && receipt.runId.length > 0);
  assert(Array.isArray(receipt.artifacts), 'Missing runner artifact inventory');
  if (receipt.artifactDirectory) {
    assert.deepEqual(
      receipt.artifacts,
      artifactsIn(receipt.artifactDirectory, ['runner.json']),
      'Runner artifact inventory differs'
    );
  } else {
    assert.deepEqual(receipt.artifacts, []);
  }
  if (receipt.artifacts.length) {
    validateArtifacts(receipt.artifacts);
  }
  return receipt;
}
function validateIntegration(path, root) {
  const receipt = readJson(path);
  assert.equal(receipt.version, 1);
  assert.equal(receipt.worktree, root);
  assert.equal(receipt.success, true);
  assert.equal(receipt.discoveryOnly, false);
  assert.equal(receipt.equivalencePassed, true);
  assert.equal(receipt.total, 6);
  assert.equal(receipt.maxActive, 3);
  assert.equal(receipt.deadlineMs, 600000);
  assert.deepEqual(receipt.errors, []);
  assert(Number.isFinite(receipt.elapsedMs) && receipt.elapsedMs < 600000);
  const home = receipt.artifactDirectory;
  assert(isAbsolute(home) && realpathSync(home) === home);
  assert.deepEqual(
    readJson(join(home, 'result.json')),
    receipt,
    'Coordinator retained result differs'
  );
  const manifest = readJson(join(home, 'manifest.json'));
  for (const [key, value] of Object.entries(manifest)) {
    assert.deepEqual(receipt[key], value, `Coordinator manifest differs: ${key}`);
  }
  assert.deepEqual(manifest.discoveryOptions, {
    staticParse: false,
    staticParseConcurrency: 1,
    pool: 'forks',
    maxWorkers: 1,
    isolate: true,
    fileParallelism: false,
    sequenceConcurrent: false,
    maxConcurrency: 1,
  });
  const queue = readJson(join(home, 'queue.json'));
  assert.equal(queue.maxActive, 3);
  assert.equal(queue.interrupted, false);
  assert.deepEqual(queue.cancelled, []);
  assert.deepEqual(
    [...queue.launched].sort((a, b) => a - b),
    [1, 2, 3, 4, 5, 6]
  );
  const index = readJson(join(home, 'artifact-index.json'));
  assert(Array.isArray(index) && index.length > 0, 'Missing coordinator artifact index');
  const indexed = new Set();
  for (const row of index) {
    assert(
      typeof row.file === 'string' &&
        row.file &&
        !isAbsolute(row.file) &&
        !row.file.split('/').includes('..')
    );
    assert(!indexed.has(row.file), 'Duplicate coordinator artifact');
    indexed.add(row.file);
    const actual = artifactRecord(join(home, row.file));
    assert.equal(actual.bytes, row.bytes);
    assert.equal(actual.sha256, row.sha256);
  }
  for (const file of [
    'manifest.json',
    'queue.json',
    ...[1, 2, 3, 4, 5, 6].map((i) => `shard-${i}/runner.json`),
  ]) {
    assert(indexed.has(file), `Coordinator index omits ${file}`);
  }
  for (let shard = 1; shard <= 6; shard++) {
    const child = readJson(join(home, `shard-${shard}/runner.json`));
    assert.deepEqual(child, {
      runId: receipt.runId,
      shard,
      exitCode: 0,
      cleanupSucceeded: true,
      timedOut: false,
    });
  }
  return { receipt, artifacts: artifactsIn(home) };
}
function benchmarkArtifacts(directory, name) {
  const output = join(
    directory,
    name === 'traversal' ? 'mobile-combined.json' : 'mobile-combat.json'
  );
  const report = readJson(output);
  assert.equal(report.schemaVersion, 1, 'Unknown benchmark schema');
  assert.equal(report.kind, 'realtime-client', 'Unknown benchmark kind');
  assert.equal(report.status, 'passed', 'Benchmark did not pass');
  assert(!Object.hasOwn(report, 'validationFailure'), 'Benchmark validation failed');
  assert.equal(report.details.cleanupComplete, true, 'Benchmark cleanup incomplete');
  assert.deepEqual(report.details.failures, [], 'Benchmark recorded failures');
  assert.equal(report.measurement.cleanup, 'complete', 'Measurement cleanup incomplete');
  const expected = {
    browser: 'chromium',
    dpr: 3,
    cpuSlowdown: name === 'traversal' ? 4 : 1,
    network: name === 'traversal' ? 'normal' : 'clean',
    seed: 42,
    workload: name,
    build: 'production',
    warmupSeconds: 5,
    measuredSeconds: 15,
    viewports: ['touch-portrait'],
    renderDpr: 'native',
    renderGlow: 'full',
    headed: false,
  };
  for (const [key, value] of Object.entries(expected)) {
    assert.deepEqual(
      report.measurement.parameters[key],
      value,
      `Benchmark requested option differs: ${key}`
    );
  }
  assert(Array.isArray(report.details.scenarios), 'Missing benchmark scenarios');
  assert.deepEqual(
    report.details.scenarios.map((row) => row.scenario.name),
    expected.viewports,
    'Benchmark scenarios differ'
  );
  const artifacts = [artifactRecord(output)];
  for (const row of report.details.scenarios) {
    assert.equal(row.status, 'passed', 'Benchmark scenario did not pass');
    assert.deepEqual(row.errors, [], 'Benchmark scenario errors');
    assert.deepEqual(row.warnings, [], 'Benchmark scenario warnings');
    const screenshot = `${output}.${row.scenario.name}.png`;
    assert.equal(row.screenshot, screenshot, 'Benchmark screenshot path differs');
    artifacts.push(artifactRecord(screenshot));
  }
  return artifacts;
}
function validateStage(row, receipt) {
  assert.equal(row.exitCode, 0);
  assert.equal(row.success, true);
  assert.deepEqual(row.command, reviewCommand(row.name, receipt.artifactDirectory));
  validateArtifacts(row.artifacts);
  const home = join(receipt.artifactDirectory, row.name);
  const expectedArtifacts = artifactsIn(home);
  if (row.name === 'integration') {
    expectedArtifacts.push(
      ...validateIntegration(join(home, 'shards.json'), receipt.worktree).artifacts
    );
  } else if (row.name === 'frame') {
    expectedArtifacts.push(artifactRecord(join(receipt.artifactDirectory, 'frame-work.json')));
  } else {
    expectedArtifacts.push(...benchmarkArtifacts(receipt.artifactDirectory, row.name));
  }
  assert.deepEqual(row.artifacts, expectedArtifacts, 'Stage artifact inventory differs');
  assert(
    row.artifacts.some((item) => item.path === join(home, 'output.log')),
    'Missing stage console retention'
  );
  if (row.name === 'integration') {
    validateIntegration(join(home, 'shards.json'), receipt.worktree);
    validateRunner(join(home, 'runner.json'), receipt.worktree, 'shards');
  } else if (row.name === 'frame') {
    const frame = readJson(join(receipt.artifactDirectory, 'frame-work.json'));
    assert.equal(frame.kind, 'frame-work');
    assert.equal(frame.result.frameWork.length, 120);
    assert(frame.result.frameImageSha256, 'Missing frame image witness');
  } else {
    validateRunner(join(home, 'runner.json'), receipt.worktree, 'benchmark-client');
    const output = join(
      receipt.artifactDirectory,
      row.name === 'traversal' ? 'mobile-combined.json' : 'mobile-combat.json'
    );
    assert(
      row.artifacts.some((item) => item.path === output),
      'Missing benchmark report retention'
    );
    benchmarkArtifacts(receipt.artifactDirectory, row.name);
  }
}
export function validateReviewReceipt(path, { checkCurrentSource = true } = {}) {
  const receipt = readJson(path);
  assert.equal(receipt.version, 1);
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
    stages
  );
  assert(Array.isArray(receipt.sourceIdentity.files), 'Missing review source rows');
  assert.equal(
    digest(JSON.stringify(receipt.sourceIdentity.files)),
    receipt.sourceIdentity.sha256,
    'Review source identity is internally inconsistent'
  );
  if (checkCurrentSource) {
    assert.deepEqual(
      reviewSourceIdentity(receipt.worktree),
      receipt.sourceIdentity,
      'Review source identity changed'
    );
  }
  for (const row of receipt.stages) {
    validateStage(row, receipt);
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
      version: 1,
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
    assert.equal(value, stages[receipt.stages.length], 'Review stage order differs');
    const home = join(directory, value);
    const artifacts = artifactsIn(home);
    if (value === 'integration') {
      artifacts.push(...validateIntegration(join(home, 'shards.json'), receipt.worktree).artifacts);
    }
    if (value === 'frame') {
      artifacts.push(artifactRecord(join(directory, 'frame-work.json')));
    } else if (value !== 'integration') {
      artifacts.push(...benchmarkArtifacts(directory, value));
    }
    const row = {
      name: value,
      command: args.slice(3),
      exitCode: Number(args[2]),
      success: Number(args[2]) === 0,
      artifacts,
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
      assert(receipt.success, 'Review stage or final retention failed');
      assert.deepEqual(
        receipt.stages.map((row) => row.name),
        stages
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
      if (receipt.exitCode === 0) {
        receipt.exitCode = 1;
      }
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
