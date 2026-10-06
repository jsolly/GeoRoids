import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  appendFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isShardCapacity, parseShardCapacity, planShards } from './integration-shard-plan.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const totalShards = 6;
const END_TO_END_DEADLINE_MS = 600000;
const serialOptions = [
  '--pool=forks',
  '--maxWorkers=1',
  '--sequence.concurrent=false',
  '--maxConcurrency=1',
  '--isolate=true',
  '--fileParallelism=false',
];
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
export function writeJson(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}
const timingPhases = [
  'environmentSetupDuration',
  'prepareDuration',
  'setupDuration',
  'collectDuration',
  'duration',
];
function sameTimingFiles(actual, expected) {
  return (
    new Set(actual).size === actual.length &&
    JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort())
  );
}
function timingPhaseTotal(diagnostic) {
  required(
    diagnostic &&
      timingPhases.every((key) => Number.isFinite(diagnostic[key]) && diagnostic[key] >= 0),
    'Invalid timing phase duration'
  );
  return timingPhases.reduce((total, key) => total + diagnostic[key], 0);
}
export function validateTimingReport(receipt, issued, expectedFiles) {
  required(
    receipt.version === 1 &&
      receipt.runId === issued.runId &&
      receipt.shard === issued.index &&
      receipt.worktree === issued.worktree &&
      receipt.sourceFingerprint === issued.sourceFingerprint.sha256 &&
      receipt.node === process.version &&
      receipt.vitest ===
        readJson(createRequire(import.meta.url).resolve('vitest/package.json')).version &&
      receipt.complete === true &&
      receipt.reason === 'passed' &&
      Array.isArray(receipt.evidenceErrors) &&
      receipt.evidenceErrors.length === 0 &&
      receipt.unhandledErrorCount === 0,
    'incomplete or mismatched receipt'
  );
  required(Array.isArray(receipt.files), 'missing file rows');
  required(
    sameTimingFiles(
      receipt.files.map((row) => row.file),
      expectedFiles
    ),
    'file set differs'
  );
  for (const row of receipt.files) {
    const total = timingPhaseTotal(row.diagnostic);
    required(
      row.state === 'passed' &&
        row.ended === true &&
        total > 0 &&
        row.phaseTotalMs === total &&
        ['queuedAtMs', 'collectedAtMs', 'startedAtMs', 'endedAtMs'].every(
          (key) => Number.isFinite(row[key]) && row[key] >= 0
        ) &&
        row.queuedAtMs <= row.collectedAtMs &&
        row.collectedAtMs <= row.startedAtMs &&
        row.startedAtMs <= row.endedAtMs &&
        row.queuedToEndMs === row.endedAtMs - row.queuedAtMs &&
        row.reporterObservedStartedToEndMs === row.endedAtMs - row.startedAtMs,
      'invalid completed file row'
    );
  }
  return receipt;
}

export function authorizeDiscoveryEvidence(worker) {
  required(process.env.GEOROIDS_DISCOVERY_EVIDENCE === '1', 'Discovery evidence is not authorized');
  const path = process.env.GEOROIDS_DISCOVERY_ISSUED;
  required(typeof path === 'string', 'Discovery issuance is missing');
  const issued = readJson(path);
  required(
    (statSync(path).mode & 0o077) === 0 && issued.directory === realpathSync(dirname(path)),
    'Discovery issuance is not private or escaped its directory'
  );
  required(
    dirname(dirname(issued.directory)) === join(root, '.performance/integration-shards'),
    'Discovery evidence escaped its worktree'
  );
  required(
    issued.worktree === root &&
      issued.index === 'discovery' &&
      startTime(issued.childPid) === issued.childStart,
    'Discovery issued identity differs'
  );
  let pid = process.pid;
  if (worker) {
    for (let depth = 0; depth < 20 && pid !== issued.childPid && pid > 1; depth++) {
      pid = parentPid(pid);
    }
  }
  required(pid === issued.childPid, 'Discovery evidence writer is outside issued ancestry');
  return issued;
}

const compileControls = [
  'NODE_COMPILE_CACHE',
  'NODE_DISABLE_COMPILE_CACHE',
  'NODE_COMPILE_CACHE_PORTABLE',
  'NODE_COMPILE_CACHE_READONLY',
  'NODE_COMPILE_CACHE_READ_ONLY',
];
const observedClock = () => ({ wallMs: Date.now(), monotonicMs: performance.now() });
export function compileCacheEnvironment(treatment, directory, inherited) {
  required(['disabled', 'cold'].includes(treatment), 'Unknown native compile-cache treatment');
  required(!inherited.NODE_V8_COVERAGE, 'Native compile-cache diagnostic refuses V8 coverage');
  required(
    !/(?:compil(?:e|ation)[-_]cache|coverage)/iu.test(inherited.NODE_OPTIONS ?? ''),
    'Native compile-cache diagnostic refuses conflicting Node options'
  );
  const environment = { ...inherited };
  for (const key of compileControls) {
    delete environment[key];
  }
  if (treatment === 'disabled') {
    environment.NODE_DISABLE_COMPILE_CACHE = '1';
  } else {
    const cache = join(directory, 'native-compile-cache');
    // mkdir without recursive refuses existing paths and symlinks.
    mkdirSync(cache, { mode: 0o700 });
    required(
      realpathSync(cache) === cache &&
        (lstatSync(cache).mode & 0o077) === 0 &&
        readdirSync(cache).length === 0,
      'Native compile-cache must be new empty private storage'
    );
    environment.NODE_COMPILE_CACHE = cache;
  }
  return environment;
}
function validateCompileCacheWorkers(environments, manifest, directory, collection) {
  const treatment = manifest.nativeCompileCacheTreatment;
  if (!treatment) {
    return;
  }
  required(
    new Set(environments.map((record) => `${record.workerPid}:${record.workerTimeOrigin}`)).size ===
      environments.length,
    'Native compile-cache diagnostic requires fresh file workers'
  );
  const cache = join(directory, 'native-compile-cache');
  if (treatment === 'cold') {
    required(
      !lstatSync(cache).isSymbolicLink() &&
        realpathSync(cache) === cache &&
        (statSync(cache).mode & 0o077) === 0,
      'Native compile-cache directory escaped or is not private'
    );
  }
  const snapshot = readJson(join(directory, 'native-cache-collection.json'));
  required(
    snapshot.complete === true &&
      snapshot.runId === manifest.runId &&
      snapshot.nonce === manifest.nativeCompileCacheNonce &&
      snapshot.sourceFingerprint === manifest.sourceFingerprint.sha256 &&
      snapshot.node === process.version &&
      snapshot.vitest === collection.vitest &&
      snapshot.vite === collection.vite &&
      snapshot.treatment === treatment &&
      Array.isArray(snapshot.evidenceErrors) &&
      snapshot.evidenceErrors.length === 0,
    'Native compile-cache collection snapshot is invalid'
  );
  required(
    Array.isArray(snapshot.files) &&
      JSON.stringify(snapshot.files.map((row) => row.file).sort()) ===
        JSON.stringify(collection.files.map((row) => row.file).sort()) &&
      snapshot.files.every((row) =>
        [
          'environmentSetupDuration',
          'prepareDuration',
          'setupDuration',
          'collectDuration',
          'duration',
        ].every((key) => Number.isFinite(row.diagnostic[key]) && row.diagnostic[key] >= 0)
      ),
    'Native compile-cache module diagnostics differ'
  );
  const clocks = [
    snapshot.registeredAt,
    snapshot.snapshotStartedAt,
    snapshot.snapshotFinishedBeforeWrite,
  ];
  required(
    clocks.every(
      (clock) => Number.isFinite(clock?.wallMs) && Number.isFinite(clock?.monotonicMs)
    ) &&
      clocks[0].monotonicMs <= clocks[1].monotonicMs &&
      clocks[1].monotonicMs <= clocks[2].monotonicMs,
    'Native compile-cache snapshot chronology differs'
  );
  for (const record of environments) {
    const observed = record.nativeCompileCache;
    required(
      observed &&
        observed.treatment === treatment &&
        record.architecture === process.arch &&
        record.platform === process.platform &&
        record.node === process.version &&
        record.sourceFingerprint === manifest.sourceFingerprint.sha256 &&
        record.vite === collection.vite &&
        observed.nonce === manifest.nativeCompileCacheNonce,
      'Native compile-cache worker provenance differs'
    );
    required(
      observed.controls.NODE_COMPILE_CACHE_PORTABLE === null &&
        observed.controls.NODE_COMPILE_CACHE_READ_ONLY === null &&
        observed.controls.NODE_COMPILE_CACHE_READONLY === null &&
        Number.isFinite(record.workerTimeOrigin) &&
        record.workerTimeOrigin > 0 &&
        record.workerTimeOrigin <= record.observedAt &&
        Number.isFinite(record.observedClock?.monotonicMs) &&
        Math.abs(
          record.workerTimeOrigin + record.observedClock.monotonicMs - record.observedClock.wallMs
        ) < 2000,
      'Native compile-cache controls differ'
    );
    required(
      treatment === 'disabled'
        ? observed.directory === null &&
            observed.controls.NODE_COMPILE_CACHE === null &&
            observed.controls.NODE_DISABLE_COMPILE_CACHE === '1'
        : observed.controls.NODE_COMPILE_CACHE === cache &&
            observed.controls.NODE_DISABLE_COMPILE_CACHE === null &&
            typeof observed.directory === 'string' &&
            (observed.directory === cache || dirname(observed.directory) === cache) &&
            realpathSync(observed.directory) === observed.directory,
      'Native compile-cache activation differs'
    );
  }
}

function sourceFingerprint(worktree) {
  const result = spawnSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { cwd: worktree, encoding: 'utf8' }
  );
  required(result.status === 0, 'Cannot inventory discovery inputs');
  const hash = createHash('sha256');
  const inputs = [
    ...new Set(
      result.stdout
        .split('\0')
        .filter(
          (file) =>
            file &&
            !file.startsWith('.performance/') &&
            !file.startsWith('logs/') &&
            file !== 'node_modules' &&
            !file.startsWith('node_modules/')
        )
    ),
  ].sort();
  for (const file of inputs) {
    hash.update(`${file}\0`);
    hash.update(readFileSync(join(worktree, file)));
    hash.update('\0');
  }
  return { sha256: hash.digest('hex'), files: inputs };
}

export function validateDiscoveryEvidence(directory, manifest, files) {
  const collection = readJson(join(directory, 'collection.json'));
  required(
    collection.runId === manifest.runId &&
      collection.vitest === '5.0.1' &&
      collection.node === process.version &&
      typeof collection.vite === 'string' &&
      collection.vite.length > 0 &&
      collection.architecture === process.arch &&
      collection.platform === process.platform &&
      collection.completedAt >= manifest.startedAt,
    'Discovery tool or run identity differs'
  );
  required(
    Array.isArray(collection.files) &&
      Array.isArray(collection.unhandledErrors) &&
      collection.unhandledErrors.length === 0,
    'Discovery has unhandled errors or malformed evidence'
  );
  required(
    collection.files.every((file) => Array.isArray(file.errors) && file.errors.length === 0),
    'Discovery has collected file errors'
  );
  required(
    JSON.stringify(collection.files.map((file) => realpathSync(file.file)).sort()) ===
      JSON.stringify(files),
    'Collected module inventory differs'
  );
  const environments = readdirSync(join(directory, 'environments')).map((name) =>
    readJson(join(directory, 'environments', name))
  );
  required(
    JSON.stringify(environments.map((record) => realpathSync(record.file)).sort()) ===
      JSON.stringify(files),
    'Resolved environment inventory differs'
  );
  required(
    environments.every(
      (record) =>
        record.runId === manifest.runId &&
        record.vitest === collection.vitest &&
        record.node === collection.node &&
        typeof record.environment === 'string' &&
        record.environment.length > 0 &&
        Number.isInteger(record.workerPid) &&
        record.workerPid > 0 &&
        record.observedAt >= manifest.startedAt
    ),
    'Resolved environment evidence is malformed or stale'
  );
  validateCompileCacheWorkers(environments, manifest, directory, collection);
  return { collection, environments };
}

export function captureChild(child, directory, onFailure = () => {}) {
  const outputErrors = [];
  const failed = new Set();
  let launchError;
  let stopRequested = false;
  const fail = (sink, error) => {
    if (!failed.has(sink)) {
      failed.add(sink);
      outputErrors.push({ sink, message: String(error) });
      onFailure();
    }
    if (
      !stopRequested &&
      !child.cleanupStopRequested &&
      child.exitCode === null &&
      child.signalCode === null
    ) {
      stopRequested = true;
      child.cleanupStopRequested = true;
      try {
        child.kill('SIGTERM');
      } catch (stopError) {
        outputErrors.push({ sink: 'runner-stop', message: String(stopError) });
      }
    }
  };
  for (const name of ['output', 'stdout', 'stderr']) {
    try {
      appendFileSync(join(directory, `${name}.log`), '', { mode: 0o600 });
    } catch (error) {
      fail(name === 'output' ? 'combined' : name, error);
    }
  }
  for (const name of ['stdout', 'stderr']) {
    child[name].on('error', (error) => fail(name, error));
    child[name].on('data', (chunk) => {
      for (const [sink, path] of [
        ['combined', join(directory, 'output.log')],
        [name, join(directory, `${name}.log`)],
      ]) {
        if (!failed.has(sink)) {
          try {
            appendFileSync(path, chunk, { mode: 0o600 });
          } catch (error) {
            fail(sink, error);
          }
        }
      }
    });
  }
  child.once('error', (error) => {
    launchError = String(error);
  });
  return new Promise((accept) => {
    let settled = false;
    let closeDeadline;
    const finish = (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(closeDeadline);
      const outcome = { code, signal, error: launchError, outputErrors };
      try {
        writeJson(join(directory, 'console-receipt.json'), outcome);
      } catch (error) {
        outputErrors.push({ sink: 'console-receipt', message: String(error) });
      }
      accept(outcome);
    };
    child.once('exit', (code, signal) => {
      closeDeadline = setTimeout(() => {
        fail('output-close', new Error('Inherited output pipes survived the issued child exit'));
        child.stdout.destroy();
        child.stderr.destroy();
        finish(code, signal);
      }, 2000);
    });
    child.once('close', finish);
  });
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') {
      return false;
    }
    throw error;
  }
}
function startTime(pid) {
  const result = spawnSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8' });
  if (result.status !== 0 || !result.stdout.trim()) {
    throw new Error(`Cannot inspect PID ${pid}: ${result.stderr}`);
  }
  return result.stdout.trim();
}
function parentPid(pid) {
  const result = spawnSync('ps', ['-p', String(pid), '-o', 'ppid='], { encoding: 'utf8' });
  if (result.status !== 0 || !/^\d+$/u.test(result.stdout.trim())) {
    throw new Error(`Cannot inspect parent of PID ${pid}`);
  }
  return Number(result.stdout.trim());
}
function required(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
function readLock(lock, owner, worktree) {
  required(
    Number(readFileSync(join(lock, 'pid'), 'utf8').trim()) === owner,
    'Common lock owner differs'
  );
  required(
    realpathSync(readFileSync(join(lock, 'worktree'), 'utf8').trim()) === worktree,
    'Common lock worktree differs'
  );
  required(alive(owner), 'Common lock owner is dead');
}
export async function authorizeChild({
  childPid,
  coordinatorPid,
  worktree,
  lock,
  manifest,
  nonce,
  runId,
}) {
  const deadline = Date.now() + 5000;
  let record;
  while (!record && Date.now() < deadline) {
    try {
      record = readJson(manifest);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
      await delay(25);
    }
  }
  required(record, 'Coordinator child manifest handshake expired');
  required(process.ppid === childPid, 'Authorization helper is not owned by the child');
  return validateIssuedChild(record, {
    childPid,
    coordinatorPid,
    worktree,
    lock,
    manifest,
    nonce,
    runId,
  });
}
function validateIssuedChild(
  record,
  { childPid, coordinatorPid, worktree, lock, manifest, nonce, runId }
) {
  const canonicalWorktree = realpathSync(worktree);
  required(
    record.version === 1 &&
      record.childPid === childPid &&
      record.coordinatorPid === coordinatorPid,
    'Child PID or coordinator differs'
  );
  required(record.nonce === nonce && /^[a-f0-9]{64}$/u.test(nonce ?? ''), 'Invalid child nonce');
  required(
    record.runId === runId && typeof runId === 'string' && runId.length > 0,
    'Run ID differs'
  );
  required(
    record.worktree === canonicalWorktree && record.lock === realpathSync(lock),
    'Child worktree or common lock differs'
  );
  required(statSync(manifest).mode % 0o1000 === 0o600, 'Child manifest permissions must be 0600');
  required(
    realpathSync(dirname(manifest)) === realpathSync(record.directory),
    'Child manifest escaped resource directory'
  );
  required(
    realpathSync(dirname(record.directory)) === realpathSync(record.runDirectory) &&
      record.directory === join(record.runDirectory, `shard-${record.index}`),
    'Child resources escaped run directory'
  );
  required(
    realpathSync(dirname(record.runDirectory)) ===
      realpathSync(join(canonicalWorktree, '.performance/integration-shards')),
    'Run directory escaped worktree evidence home'
  );
  const run = readJson(join(record.runDirectory, 'manifest.json'));
  required(
    run.runId === runId &&
      run.coordinatorPid === coordinatorPid &&
      run.ownerPid === record.ownerPid &&
      run.worktree === canonicalWorktree &&
      isShardCapacity(run.maxActive) &&
      record.maxActive === run.maxActive,
    'Run manifest differs'
  );
  required(
    parentPid(childPid) === coordinatorPid && parentPid(coordinatorPid) === record.ownerPid,
    'Coordinator process ancestry differs'
  );
  required(
    startTime(childPid) === record.childStart &&
      startTime(coordinatorPid) === record.coordinatorStart &&
      startTime(record.ownerPid) === record.ownerStart,
    'Process identity changed'
  );
  readLock(lock, record.ownerPid, canonicalWorktree);
  required(
    Number.isInteger(record.index) &&
      record.index >= 1 &&
      record.index <= totalShards &&
      record.total === totalShards,
    'Invalid shard assignment'
  );
  required(
    [record.vitePort, record.serverPort].every(
      (port) => Number.isInteger(port) && port > 0 && port <= 65535
    ) && record.vitePort !== record.serverPort,
    'Invalid shard ports'
  );
  required(
    record.assignmentPath === join(record.runDirectory, 'assignments.json') &&
      realpathSync(record.assignmentPath) === record.assignmentPath,
    'Assignment path escaped private run'
  );
  required(
    statSync(record.assignmentPath).mode % 0o1000 === 0o600,
    'Assignment permissions must be 0600'
  );
  required(
    createHash('sha256').update(readFileSync(record.assignmentPath)).digest('hex') ===
      record.assignmentSha256,
    'Assignment digest differs'
  );
  const plan = readJson(record.assignmentPath);
  required(
    plan.runId === runId &&
      plan.worktree === canonicalWorktree &&
      plan.total === totalShards &&
      plan.maxActive === run.maxActive,
    'Assignment identity differs'
  );
  return { ...record, plan };
}
export function authorizeSequencer() {
  const manifest = process.env.GEOROIDS_SHARD_MANIFEST;
  required(typeof manifest === 'string', 'No issued sequencer manifest');
  const record = readJson(manifest);
  let pid = process.pid;
  const seen = new Set();
  while (pid !== record.childPid && seen.size < 32) {
    required(pid > 1 && !seen.has(pid), 'Vitest ancestry does not reach issued child');
    seen.add(pid);
    pid = parentPid(pid);
  }
  required(pid === record.childPid, 'Vitest ancestry does not reach issued child');
  return validateIssuedChild(record, {
    childPid: record.childPid,
    coordinatorPid: record.coordinatorPid,
    worktree: root,
    lock: record.lock,
    manifest,
    nonce: process.env.GEOROIDS_SHARD_NONCE,
    runId: process.env.GEOROIDS_SHARD_RUN_ID,
  });
}
function verifyStoppedCoordinator(control, ownerPid, cancellationOnly = true) {
  const record = readJson(join(control, 'run.json'));
  required(
    record.ownerPid === ownerPid &&
      record.worktree === root &&
      record.ownerStart === startTime(ownerPid),
    'Owner cancellation identity differs'
  );
  const result = readJson(join(record.runDirectory, 'result.json'));
  const queue = readJson(join(record.runDirectory, 'queue.json'));
  required(
    result.runId === record.runId &&
      result.coordinatorPid === record.coordinatorPid &&
      typeof result.success === 'boolean' &&
      (!cancellationOnly || (result.success === false && queue.interrupted === true)),
    'Coordinator cancellation receipt missing or differs'
  );
  const persisted = readdirSync(record.runDirectory, { withFileTypes: true })
    .filter((item) => item.isDirectory() && /^shard-\d+$/u.test(item.name))
    .map((item) => Number(item.name.slice(6)))
    .sort((a, b) => a - b);
  required(
    JSON.stringify([...queue.launched].sort((a, b) => a - b)) === JSON.stringify(persisted),
    'Coordinator queue omits persisted shard ownership'
  );
  const discovery = issuedDiscovery(record);
  required(retainGroup(discovery).length === 0, 'Discovery processes survived coordinator exit');
  for (const index of queue.launched) {
    const directory = join(record.runDirectory, `shard-${index}`);
    const spawnRecord = readJson(join(directory, 'spawn.json'));
    const child = readJson(join(directory, 'child.json'));
    required(
      spawnRecord.runId === record.runId &&
        spawnRecord.index === index &&
        spawnRecord.childPid === child.childPid &&
        child.ownerPid === record.ownerPid &&
        child.coordinatorPid === record.coordinatorPid,
      'Issued shard identity differs from launch'
    );
    const receipt = readJson(join(directory, 'runner.json'));
    required(
      receipt.runId === record.runId &&
        receipt.shard === index &&
        receipt.cleanupSucceeded === true,
      `Cancellation cleanup receipt failed for shard ${index}`
    );
    required(
      groupMembers(child.childPid).length === 0,
      `Cancellation process group survived shard ${index}`
    );
    confirmPortsStopped([{ ...child, pid: child.childPid }]);
  }
}
function issuedDiscovery(record) {
  const directory = join(record.runDirectory, 'discovery');
  const issued = readJson(join(directory, 'child.json'));
  required(
    issued.runId === record.runId &&
      issued.ownerPid === record.ownerPid &&
      issued.coordinatorPid === record.coordinatorPid &&
      issued.worktree === root &&
      issued.directory === directory,
    'Discovery ownership identity differs'
  );
  return { ...issued, pid: issued.childPid };
}
export function integrationFiles(worktree) {
  const files = [];
  function visit(directory) {
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, item.name);
      if (item.isDirectory()) {
        visit(path);
      } else if (item.isFile() && /\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(item.name)) {
        files.push(realpathSync(path));
      }
    }
  }
  visit(join(worktree, 'tests/integration'));
  return files.sort();
}
function caseKeys(cases) {
  const occurrences = new Map();
  return cases
    .map((test) => {
      required(
        typeof test.file === 'string' && typeof test.name === 'string' && test.name.length > 0,
        'Invalid case identity'
      );
      required(
        test.location &&
          Number.isInteger(test.location.line) &&
          Number.isInteger(test.location.column),
        'Missing source location for case identity'
      );
      const base = JSON.stringify([
        resolve(test.file),
        test.name,
        test.location.line,
        test.location.column,
      ]);
      const occurrence = (occurrences.get(base) ?? 0) + 1;
      occurrences.set(base, occurrence);
      return `${base}#${occurrence}`;
    })
    .sort();
}
export function validateDiscovery(discovery, files) {
  required(
    Array.isArray(discovery) && discovery.length > 0,
    'Missing discovered integration cases'
  );
  const discoveredFiles = [...new Set(discovery.map((test) => resolve(test.file)))].sort();
  required(
    JSON.stringify(discoveredFiles) === JSON.stringify(files),
    'Discovery differs from the complete integration file set'
  );
  // Vitest list joins suites with " > "; its JSON reporter joins them with spaces.
  const normalized = discovery.map((test) => ({ ...test, name: test.name.replaceAll(' > ', ' ') }));
  caseKeys(normalized);
  return normalized;
}
export function aggregateReports(discovery, files, reports) {
  required(reports.length === totalShards, 'Missing shard report');
  const seenFiles = new Set(),
    actual = [];
  for (const report of reports) {
    required(
      report.success === true &&
        report.numFailedTests === 0 &&
        report.numPendingTests === 0 &&
        report.numTodoTests === 0 &&
        report.numFailedTestSuites === 0 &&
        report.numPendingTestSuites === 0,
      'Shard reported failure or skipped tests'
    );
    required(
      Array.isArray(report.testResults) && report.testResults.length > 0,
      'Shard omitted file results'
    );
    let count = 0;
    for (const result of report.testResults) {
      const file = resolve(result.name);
      required(
        files.includes(file) && !seenFiles.has(file),
        `Unexpected or duplicated integration file ${file}`
      );
      seenFiles.add(file);
      required(
        result.status === 'passed' &&
          Array.isArray(result.assertionResults) &&
          result.assertionResults.length > 0,
        `Incomplete file ${file}`
      );
      for (const assertion of result.assertionResults) {
        required(
          assertion.status === 'passed' &&
            Array.isArray(assertion.failureMessages) &&
            assertion.failureMessages.length === 0,
          `Failed or skipped case in ${file}`
        );
        actual.push({ file, name: assertion.fullName, location: assertion.location });
        count++;
      }
    }
    required(
      count === report.numTotalTests && count === report.numPassedTests,
      'Shard count metadata differs from case evidence'
    );
  }
  required(
    JSON.stringify([...seenFiles].sort()) === JSON.stringify(files),
    'Missing integration files'
  );
  const expectedKeys = caseKeys(discovery),
    actualKeys = caseKeys(actual);
  required(
    JSON.stringify(actualKeys) === JSON.stringify(expectedKeys),
    'Duplicated, missing or changed integration cases'
  );
  return { files: files.length, cases: actual.length, caseIds: actualKeys };
}
async function reservePorts(count = 12) {
  const reservations = [];
  try {
    for (let index = 0; index < count; index++) {
      const server = createServer();
      await new Promise((accept, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', accept);
      });
      reservations.push({ server, port: server.address().port });
    }
    return reservations;
  } catch (error) {
    for (const { server } of reservations) {
      server.close();
    }
    throw error;
  }
}
function groupMembers(group) {
  const result = spawnSync('ps', ['-axo', 'pid=,pgid=,stat='], { encoding: 'utf8' });
  required(result.status === 0, `Cannot inspect owned process groups: ${result.stderr}`);
  return result.stdout
    .split('\n')
    .map((line) => line.trim().split(/\s+/u))
    .filter(([, pgid, state]) => Number(pgid) === group && !state?.startsWith('Z'))
    .map(([pid]) => Number(pid));
}
export function retainGroup(child) {
  const probe = spawnSync('ps', ['-axo', 'pid=,pgid=,stat=,lstart='], { encoding: 'utf8' });
  required(
    probe.status === 0 && !probe.stderr.trim(),
    `Cannot inspect group ownership: ${probe.stderr}`
  );
  const snapshots = probe.stdout
    .split('\n')
    .map((line) => line.trim().split(/\s+/u))
    .filter(([, group, state]) => Number(group) === child.pid && !state?.startsWith('Z'))
    .map(([pid, , , ...birth]) => ({ pid: Number(pid), start: birth.join(' ') }));
  const members = snapshots.map((member) => member.pid);
  const path = join(child.directory, 'group-ownership.json');
  let retained;
  try {
    retained = readJson(path);
    required(
      retained.group === child.pid && retained.childStart === child.childStart,
      'Group ownership identity differs'
    );
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
    retained = { group: child.pid, childStart: child.childStart, empty: false, members: [] };
  }
  if (retained.empty) {
    required(members.length === 0, `Empty owned group was reused: ${child.pid}`);
    return members;
  }
  if (members.length === 0) {
    required(groupMembers(child.pid).length === 0, 'Owned group changed during empty inspection');
    writeJson(path, { ...retained, empty: true, members: [] });
    return members;
  }
  const leaderMatches = snapshots.some(
    (member) =>
      member.pid === child.pid && member.start === child.childStart.trim().replace(/\s+/gu, ' ')
  );
  const anchorMatches = retained.members.some((member) =>
    snapshots.some(
      (current) =>
        current.pid === member.pid && current.start === member.start.trim().replace(/\s+/gu, ' ')
    )
  );
  required(leaderMatches || anchorMatches, `No proven ownership anchor for group ${child.pid}`);
  writeJson(path, { ...retained, members: snapshots });
  return members;
}
export async function cleanGroup(child) {
  if (retainGroup(child).length > 0) {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch (error) {
      if (error.code !== 'ESRCH') {
        throw error;
      }
    }
    const deadline = Date.now() + 3000;
    while (retainGroup(child).length > 0 && Date.now() < deadline) {
      await delay(50);
    }
    if (retainGroup(child).length > 0) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch (error) {
        if (error.code !== 'ESRCH') {
          throw error;
        }
      }
      await delay(100);
    }
  }
  required(retainGroup(child).length === 0, `Owned processes survived shard ${child.index}`);
}
function confirmPortsStopped(children) {
  for (const child of children) {
    for (const port of [child.vitePort, child.serverPort].filter(
      (candidate) => candidate !== undefined
    )) {
      const result = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], {
        encoding: 'utf8',
      });
      required(
        result.status === 1 && !result.stderr.trim(),
        `Shard ${child.index} port ${port} is still listening or inspection failed`
      );
    }
  }
}
async function runCoordinator(lockPath, ownerPid, discoveryMode, nativeCompileCacheTreatment) {
  required(
    !nativeCompileCacheTreatment || discoveryMode === 'node',
    'Native compile-cache treatment requires owned Node discovery only'
  );
  const maxActive = parseShardCapacity(process.env.GEOROIDS_TEST_MAX_ACTIVE_SHARDS);
  const discoverOnly = discoveryMode !== 'shards';
  const discoveryEnvironment = discoveryMode === 'jsdom' ? 'jsdom' : 'node';
  const startedAt = Date.now(),
    runId = randomUUID(),
    worktree = realpathSync(root);
  const parent = Number(ownerPid);
  required(process.ppid === parent, 'Coordinator is not owned by lock runner');
  const lock = realpathSync(lockPath);
  readLock(lock, parent, worktree);
  const artifactParent = join(worktree, '.performance/integration-shards');
  mkdirSync(artifactParent, { recursive: true });
  const runDirectory = mkdtempSync(join(artifactParent, 'run-'));
  const manifest = {
    version: 1,
    runId,
    worktree,
    lock,
    ownerPid: parent,
    ownerStart: startTime(parent),
    coordinatorPid: process.pid,
    coordinatorStart: startTime(process.pid),
    total: totalShards,
    maxActive,
    startedAt,
    deadlineMs: END_TO_END_DEADLINE_MS,
    discoveryEnvironment,
    ...(nativeCompileCacheTreatment
      ? { nativeCompileCacheTreatment, nativeCompileCacheNonce: randomBytes(32).toString('hex') }
      : {}),
    discoveryOptions: {
      staticParse: false,
      staticParseConcurrency: 1,
      pool: 'forks',
      maxWorkers: 1,
      isolate: true,
      fileParallelism: false,
      sequenceConcurrent: false,
      maxConcurrency: 1,
    },
    sourceFingerprint: sourceFingerprint(worktree),
  };
  writeJson(join(runDirectory, 'manifest.json'), manifest);
  if (process.env.GEOROIDS_COORDINATOR_CONTROL) {
    writeJson(join(process.env.GEOROIDS_COORDINATOR_CONTROL, 'run.json'), {
      ...manifest,
      runDirectory,
    });
  }
  process.stdout.write(`Integration shard evidence: ${runDirectory}\n`);
  const children = [],
    errors = [],
    reservations = [];
  let escalation;
  const ownershipPoll = setInterval(() => {
    for (const child of children) {
      try {
        retainGroup(child);
      } catch (error) {
        errors.push(String(error));
        stop();
      }
    }
  }, 1000);
  let current,
    discoveryChild,
    interrupted = false,
    deadlineExpired = false,
    discovery,
    summary,
    queue = [];
  const stop = () => {
    if (interrupted) {
      return;
    }
    interrupted = true;
    if (current?.pid) {
      try {
        retainGroup({
          pid: current.pid,
          childStart: current.issuedStart,
          directory: join(runDirectory, 'discovery'),
        });
        process.kill(-current.pid, 'SIGTERM');
      } catch (error) {
        if (error.code !== 'ESRCH') {
          errors.push(String(error));
        }
      }
    }
    const termSentPids = [];
    for (const child of children) {
      try {
        if (!child.stopRequested && !child.process.cleanupStopRequested && !child.finished) {
          retainGroup(child);
          required(startTime(child.pid) === child.childStart, 'Runner PID identity differs');
          child.stopRequested = true;
          child.process.cleanupStopRequested = true;
          child.process.kill('SIGTERM');
          termSentPids.push(child.pid);
        }
      } catch (error) {
        if (error.code !== 'ESRCH') {
          errors.push(String(error));
        }
      }
    }
    try {
      writeJson(join(runDirectory, 'stop.json'), { triggeredAt: Date.now(), termSentPids });
    } catch (error) {
      errors.push(`Stop retention failed: ${error}`);
    }
    if (!escalation) {
      escalation = setTimeout(() => {
        for (const child of [
          ...children,
          ...(current?.pid
            ? [
                {
                  pid: current.pid,
                  childStart: current.issuedStart,
                  directory: join(runDirectory, 'discovery'),
                },
              ]
            : []),
        ]) {
          try {
            if (retainGroup(child).length > 0) {
              process.kill(-child.pid, 'SIGKILL');
            }
          } catch (error) {
            if (error.code !== 'ESRCH') {
              errors.push(String(error));
            }
          }
        }
      }, 20000);
    }
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  const deadline = setTimeout(() => {
    deadlineExpired = true;
    stop();
  }, END_TO_END_DEADLINE_MS);
  async function command(args, output, env) {
    const issuedPath = join(dirname(output), 'child.json');
    const spawnedAt = observedClock();
    const child = spawn(
      process.execPath,
      [fileURLToPath(import.meta.url), 'discover', issuedPath, ...args],
      {
        cwd: worktree,
        env,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    current = child;
    discoveryChild = child;
    child.issuedStart = startTime(child.pid);
    const issued = {
      ...manifest,
      childPid: child.pid,
      childStart: child.issuedStart,
      pid: child.pid,
      directory: dirname(output),
      index: 'discovery',
      ...(nativeCompileCacheTreatment ? { spawnedAt } : {}),
    };
    retainGroup(issued);
    writeJson(issuedPath, issued);
    const outcome = await captureChild(child, dirname(output));
    current = undefined;
    if (nativeCompileCacheTreatment) {
      writeJson(join(dirname(output), 'native-cache-child-exit.json'), {
        spawnedAt,
        exitedAt: observedClock(),
        outcome,
      });
    }
    required(
      outcome.code === 0 && !outcome.signal && !outcome.error && outcome.outputErrors.length === 0,
      `Discovery failed: ${JSON.stringify(outcome)}`
    );
  }
  try {
    const discoveryDirectory = join(runDirectory, 'discovery');
    for (const name of ['tmp', 'cache', 'screenshots', 'logs', 'environments']) {
      mkdirSync(join(discoveryDirectory, name), { recursive: true });
    }
    const treatmentSetupStartedAt = observedClock();
    const diagnosticEnvironment = nativeCompileCacheTreatment
      ? compileCacheEnvironment(nativeCompileCacheTreatment, discoveryDirectory, process.env)
      : process.env;
    if (nativeCompileCacheTreatment) {
      writeJson(join(discoveryDirectory, 'native-cache-setup.json'), {
        startedAt: treatmentSetupStartedAt,
        finishedAt: observedClock(),
        initiallyEmpty: true,
        treatment: nativeCompileCacheTreatment,
      });
    }
    await command(
      [
        join(worktree, 'node_modules/vitest/vitest.mjs'),
        'list',
        'tests/integration/',
        '--config',
        'vitest.discovery.config.mjs',
        `--environment=${discoveryEnvironment}`,
        '--configLoader=runner',
        '--staticParse=false',
        '--staticParseConcurrency=1',
        `--json=${join(discoveryDirectory, 'cases.json')}`,
        ...serialOptions,
      ],
      join(discoveryDirectory, 'output.log'),
      {
        ...diagnosticEnvironment,
        GEOROIDS_DISCOVERY_EVIDENCE: '1',
        GEOROIDS_DISCOVERY_ISSUED: join(discoveryDirectory, 'child.json'),
        NODE_ENV: 'test',
        VITEST: 'true',
        GEOROIDS_WORLD_PATH: ':memory:',
        GEOROIDS_TEST_SESSION_DIR: discoveryDirectory,
        GEOROIDS_TEST_LOG_DIR: join(discoveryDirectory, 'logs'),
        GEOROIDS_TEST_SCREENSHOTS_DIR: join(discoveryDirectory, 'screenshots'),
        TMPDIR: join(discoveryDirectory, 'tmp'),
      }
    );
    const files = integrationFiles(worktree);
    discovery = validateDiscovery(readJson(join(discoveryDirectory, 'cases.json')), files);
    const collectionEvidence = validateDiscoveryEvidence(discoveryDirectory, manifest, files);
    if (nativeCompileCacheTreatment) {
      writeJson(join(discoveryDirectory, 'native-cache-collected.json'), {
        collectedAt: observedClock(),
        files: files.length,
        cases: discovery.length,
      });
    }
    required(
      sourceFingerprint(worktree).sha256 === manifest.sourceFingerprint.sha256,
      'Discovery source inputs changed during collection'
    );
    writeJson(join(runDirectory, 'discovery.json'), {
      files,
      cases: discovery,
      caseIds: caseKeys(discovery),
      evidence: collectionEvidence,
      discoveryEnvironment,
      sourceFingerprint: manifest.sourceFingerprint,
    });
    required(!interrupted, 'Coordinator interrupted during discovery');
    if (!discoverOnly) {
      const plan = planShards({
        maxActive,
        worktree,
        files,
        discovery,
        weights: readJson(join(root, 'scripts/integration-shard-weights.json')),
        runId,
      });
      const assignmentPath = join(runDirectory, 'assignments.json');
      writeJson(assignmentPath, plan);
      const assignmentSha256 = createHash('sha256')
        .update(readFileSync(assignmentPath))
        .digest('hex');
      queue = [...plan.shards].sort(
        (a, b) =>
          b.allocationWeight - a.allocationWeight ||
          b.estimatedFileMs - a.estimatedFileMs ||
          a.index - b.index
      );
      reservations.push(...(await reservePorts(totalShards * 2)));
      const active = new Set();
      async function launch(assignment) {
        required(!interrupted, 'Stopped before queued launch');
        const index = assignment.index,
          directory = join(runDirectory, `shard-${index}`),
          nonce = randomBytes(32).toString('hex');
        for (const name of ['tmp', 'cache', 'logs', 'screenshots']) {
          mkdirSync(join(directory, name), { recursive: true });
        }
        const pair = reservations.slice((index - 1) * 2, index * 2);
        await Promise.all(pair.map(({ server }) => new Promise((accept) => server.close(accept))));
        required(!interrupted, 'Stopped before child spawn');
        const child = spawn(join(worktree, 'scripts/test-runner.sh'), ['--coordinator-child'], {
          cwd: worktree,
          detached: true,
          env: {
            ...process.env,
            GEOROIDS_SHARD_MANIFEST: join(directory, 'child.json'),
            GEOROIDS_SHARD_NONCE: nonce,
            GEOROIDS_SHARD_RUN_ID: runId,
            TMPDIR: join(directory, 'tmp'),
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        writeJson(join(directory, 'spawn.json'), {
          ...manifest,
          runDirectory,
          index,
          directory,
          childPid: child.pid,
          spawnedAt: Date.now(),
        });
        const completion = captureChild(child, directory, stop);
        const record = {
          ...manifest,
          index,
          directory,
          runDirectory,
          nonce,
          assignmentPath,
          assignmentSha256,
          childPid: child.pid,
          childStart: undefined,
          vitePort: pair[0].port,
          serverPort: pair[1].port,
          launchedAt: Date.now(),
        };
        const ownedChild = {
          ...record,
          pid: child.pid,
          process: child,
          completion,
          finished: false,
          stopRequested: false,
        };
        children.push(ownedChild);
        record.childStart = startTime(child.pid);
        ownedChild.childStart = record.childStart;
        retainGroup(ownedChild);
        writeJson(join(directory, 'child.json'), record);
        const task = (async () => {
          const outcome = await completion;
          ownedChild.finished = true;
          writeJson(join(directory, 'process-exit.json'), {
            ...outcome,
            launchedAt: record.launchedAt,
            finishedAt: Date.now(),
          });
          required(
            outcome.code === 0 &&
              !outcome.signal &&
              !outcome.error &&
              outcome.outputErrors.length === 0,
            `Shard ${index} failed: ${JSON.stringify(outcome)}`
          );
          const receipt = readJson(join(directory, 'runner.json'));
          required(
            receipt.exitCode === 0 &&
              receipt.cleanupSucceeded === true &&
              receipt.timedOut === false &&
              receipt.runId === runId &&
              receipt.shard === index,
            `Shard ${index} runner receipt failed`
          );
          validateTimingReport(
            readJson(join(directory, 'file-timings.json')),
            record,
            assignment.files
          );
          await cleanGroup(ownedChild);
          confirmPortsStopped([ownedChild]);
          return { index };
        })()
          .catch((error) => {
            errors.push(error.stack ?? String(error));
            stop();
            return { index, failed: true };
          })
          .finally(() => {
            active.delete(task);
          });
        ownedChild.task = task;
        active.add(task);
      }
      while (queue.length > 0 || active.size > 0) {
        if (interrupted) {
          break;
        }
        while (queue.length > 0 && active.size < maxActive) {
          if (interrupted) {
            break;
          }
          await launch(queue.shift());
        }
        if (active.size > 0) {
          await Promise.race(active);
        }
      }
      await Promise.all(children.map((child) => child.task ?? child.completion));
      writeJson(join(runDirectory, 'queue.json'), {
        maxActive,
        launched: children.map((child) => child.index),
        cancelled: queue.map((child) => child.index),
        interrupted,
      });
      required(
        !interrupted && children.length === totalShards && queue.length === 0,
        'Not all queued shards completed'
      );
      for (const child of children) {
        required(
          readFileSync(join(child.directory, 'output.log'), 'utf8').includes(
            '✅ Tests completed successfully'
          ),
          `Shard ${child.index} console output is incomplete`
        );
      }
      summary = aggregateReports(
        discovery,
        files,
        children.map((child) => readJson(join(child.directory, 'vitest.json')))
      );
      required(
        sourceFingerprint(worktree).sha256 === manifest.sourceFingerprint.sha256,
        'Source inputs changed during execution; timing measurement is invalid'
      );
    } else {
      summary = { files: files.length, cases: discovery.length, discoveryOnly: true };
    }
  } catch (error) {
    errors.push(error.stack ?? String(error));
    stop();
  } finally {
    for (const { server } of reservations) {
      if (server.listening) {
        await new Promise((accept) => server.close(accept));
      }
    }
    if (discoveryChild?.pid) {
      try {
        const cleanupStartedAt = observedClock();
        await cleanGroup({
          pid: discoveryChild.pid,
          childStart: discoveryChild.issuedStart,
          directory: join(runDirectory, 'discovery'),
          index: 'discovery',
        });
        if (nativeCompileCacheTreatment) {
          writeJson(join(runDirectory, 'discovery/native-cache-cleanup.json'), {
            startedAt: cleanupStartedAt,
            finishedAt: observedClock(),
            succeeded: true,
          });
        }
      } catch (error) {
        errors.push(String(error));
      }
    }
    for (const child of children) {
      try {
        await cleanGroup(child);
      } catch (error) {
        errors.push(String(error));
      }
    }
    try {
      confirmPortsStopped(children);
    } catch (error) {
      errors.push(String(error));
    }
    try {
      writeJson(join(runDirectory, 'queue.json'), {
        maxActive,
        launched: children.map((child) => child.index),
        cancelled: queue.map((child) => child.index),
        interrupted,
      });
    } catch (error) {
      errors.push(`Queue retention failed: ${error}`);
    }
    clearInterval(ownershipPoll);
    clearTimeout(deadline);
    clearTimeout(escalation);
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
  if (interrupted && errors.length === 0) {
    errors.push('Coordinator interrupted');
  }
  const indexingStartedAt = observedClock();
  let indexingFinishedAt;
  const artifacts = [];
  function retain(directory) {
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, item.name);
      if (nativeCompileCacheTreatment) {
        required(!item.isSymbolicLink(), 'Native compile-cache output retention refuses symlinks');
      }
      if (item.isDirectory()) {
        retain(path);
      } else if (item.isFile() && item.name !== 'child.json') {
        artifacts.push({
          file: path.slice(runDirectory.length + 1),
          bytes: statSync(path).size,
          sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
        });
      }
    }
  }
  try {
    retain(runDirectory);
    writeJson(join(runDirectory, 'artifact-index.json'), artifacts);
    indexingFinishedAt = observedClock();
    if (nativeCompileCacheTreatment === 'cold') {
      required(
        artifacts.some(
          (item) => item.file.startsWith('discovery/native-compile-cache/') && item.bytes > 0
        ),
        'Cold native compile-cache produced no retained bytecode files'
      );
    }
  } catch (error) {
    errors.push(`Output retention failed: ${error}`);
  }
  try {
    required(
      sourceFingerprint(worktree).sha256 === manifest.sourceFingerprint.sha256,
      'Source inputs changed before final measurement acceptance'
    );
  } catch (error) {
    errors.push(String(error));
  }
  const elapsedMs = Date.now() - startedAt;
  if (deadlineExpired || elapsedMs >= END_TO_END_DEADLINE_MS) {
    errors.push(`End-to-end shard deadline exceeded (${elapsedMs}ms)`);
  }
  const receipt = {
    ...manifest,
    artifactDirectory: runDirectory,
    elapsedMs,
    discoveryOnly: discoverOnly,
    ...(nativeCompileCacheTreatment
      ? {
          nativeCompileCacheDiagnostic: {
            treatment: nativeCompileCacheTreatment,
            semantics:
              'bytecode diagnostic only; no module-instance reuse or full-suite acceptance',
            indexingStartedAt,
            indexingFinishedAt,
            finalAcceptanceObservedAt: observedClock(),
          },
        }
      : {}),
    equivalencePassed: !discoverOnly && Array.isArray(summary?.caseIds),
    summary,
    errors,
    success: errors.length === 0 && !discoverOnly,
  };
  if (process.env.GEOROIDS_TEST_SHARD_RECEIPT) {
    try {
      writeJson(process.env.GEOROIDS_TEST_SHARD_RECEIPT, receipt);
    } catch (error) {
      errors.push(`Review receipt retention failed: ${error}`);
      receipt.success = false;
    }
  }
  writeJson(join(runDirectory, 'result.json'), receipt);
  process.stdout.write(
    `${errors.length === 0 ? 'Verified' : 'Failed'} ${discoverOnly ? 'discovery' : 'integration shards'}: ${summary?.files ?? '?'} files / ${summary?.cases ?? '?'} cases, ${(elapsedMs / 1000).toFixed(2)}s\n`
  );
  for (const error of errors) {
    console.error(error);
  }
  return errors.length === 0 ? 0 : deadlineExpired ? 124 : 1;
}
async function main(args) {
  if (args[0] === 'discover') {
    const [, issuedPath, entry, ...arguments_] = args;
    const deadline = Date.now() + 5000;
    let issued;
    while (!issued && Date.now() < deadline) {
      try {
        issued = readJson(issuedPath);
      } catch (error) {
        if (error.code !== 'ENOENT') {
          throw error;
        }
      }
      if (!issued) {
        await delay(10);
      }
    }
    required(
      issued &&
        issued.childPid === process.pid &&
        issued.childStart === startTime(process.pid) &&
        issued.coordinatorPid === process.ppid &&
        issued.coordinatorStart === startTime(process.ppid) &&
        issued.worktree === root,
      'Discovery launch authorization differs'
    );
    required((statSync(issuedPath).mode & 0o077) === 0, 'Discovery authorization is not private');
    required(
      readFileSync(join(issued.lock, 'pid'), 'utf8').trim() === String(issued.ownerPid),
      'Discovery lock owner differs'
    );
    process.argv = [process.execPath, entry, ...arguments_];
    await import(/* @vite-ignore */ pathToFileURL(entry).href);
    return process.exitCode ?? 0;
  }
  if (args[0] === 'mark-lock') {
    const [, control, owner, lock, state] = args;
    required(['ownership-pending', 'cleanup-failed'].includes(state), 'Invalid cleanup state');
    required(
      readFileSync(join(lock, 'pid'), 'utf8').trim() === owner,
      'Cleanup lock owner differs'
    );
    let run;
    try {
      run = readJson(join(control, 'run.json'));
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }
    writeJson(join(lock, `${state}.json`), {
      ownerPid: Number(owner),
      ownerStart: startTime(Number(owner)),
      worktree: root,
      control,
      run,
      failure: state === 'cleanup-failed',
      inspectionHome: control,
    });
    return 0;
  }
  if (args[0] === 'authorize') {
    const [, childPid, coordinatorPid, worktree, lock] = args;
    const record = await authorizeChild({
      childPid: Number(childPid),
      coordinatorPid: Number(coordinatorPid),
      worktree,
      lock,
      manifest: process.env.GEOROIDS_SHARD_MANIFEST,
      nonce: process.env.GEOROIDS_SHARD_NONCE,
      runId: process.env.GEOROIDS_SHARD_RUN_ID,
    });
    process.stdout.write(
      `${[record.vitePort, record.serverPort, record.directory, `${record.index}/${record.total}`].join('\n')}\n`
    );
    return 0;
  }
  if (args[0] === 'verify-stop' || args[0] === 'verify-exit') {
    verifyStoppedCoordinator(args[1], Number(args[2]), args[0] === 'verify-stop');
    return 0;
  }
  if (args[0] === 'fallback-stop') {
    const record = readJson(join(args[1], 'run.json'));
    required(
      record.ownerPid === Number(args[2]) &&
        record.worktree === root &&
        record.ownerStart === startTime(Number(args[2])),
      'Fallback owner differs'
    );
    const children = [];
    const failures = [];
    try {
      children.push(issuedDiscovery(record));
    } catch (error) {
      failures.push(String(error));
    }
    for (const item of readdirSync(record.runDirectory, { withFileTypes: true })) {
      if (item.isDirectory() && /^shard-\d+$/u.test(item.name)) {
        const path = join(record.runDirectory, item.name, 'child.json');
        try {
          const child = readJson(path);
          required(
            child.runId === record.runId &&
              child.coordinatorPid === record.coordinatorPid &&
              child.ownerPid === record.ownerPid,
            'Fallback child identity differs'
          );
          children.push({ ...child, pid: child.childPid });
        } catch (error) {
          failures.push(String(error));
        }
      }
    }
    for (const child of children) {
      try {
        await cleanGroup(child);
      } catch (error) {
        failures.push(String(error));
      }
    }
    try {
      confirmPortsStopped(children);
    } catch (error) {
      failures.push(String(error));
    }
    required(failures.length === 0, failures.join('\n'));
    return 0;
  }
  if (args[0] === 'coordinate') {
    required(
      args.length === 3 ||
        (args.length === 4 && ['--discover-only', '--discovery-node'].includes(args[3])) ||
        (args.length === 5 &&
          args[3] === '--discovery-node' &&
          ['--native-compile-cache=disabled', '--native-compile-cache=cold'].includes(args[4])),
      'Invalid coordinator discovery mode'
    );
    return runCoordinator(
      args[1],
      args[2],
      args[3] === '--discovery-node' ? 'node' : args[3] === '--discover-only' ? 'jsdom' : 'shards',
      args[4]?.split('=')[1]
    );
  }
  throw new Error('Expected coordinate or authorize');
}
if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
