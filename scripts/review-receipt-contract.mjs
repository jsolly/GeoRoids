import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  artifactRecord,
  reviewCommand,
  reviewSourceIdentity,
  validateReviewReceipt,
} from './review-receipt.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'georoids-review-contract-')));
const inheritedEnvironment = { ...process.env };
const fixtureHome = join(scratch, 'home');
const fixtureXdg = join(scratch, 'xdg');
mkdirSync(fixtureHome);
mkdirSync(fixtureXdg);
function isolatedEnvironment(input = inheritedEnvironment) {
  const environment = Object.fromEntries(
    Object.entries(input).filter(([name]) => !name.startsWith('GIT_'))
  );
  return {
    ...environment,
    HOME: fixtureHome,
    XDG_CONFIG_HOME: fixtureXdg,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
  };
}
// Direct calls to the production read-only validator also spawn Git. Isolate
// this private contract process before any fixture or validator reads occur.
for (const name of Object.keys(process.env)) {
  if (name.startsWith('GIT_')) {
    delete process.env[name];
  }
}
Object.assign(process.env, isolatedEnvironment());
const repo = join(scratch, 'repository');
mkdirSync(join(repo, 'scripts'), { recursive: true });
const json = (path, value) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value)}\n`);
};
const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
function fixtureSpawn(executable, args, options = {}) {
  return spawnSync(executable, args, {
    cwd: repo,
    encoding: 'utf8',
    ...options,
    env: isolatedEnvironment(options.env ?? process.env),
  });
}
function command(executable, args, options = {}) {
  const result = fixtureSpawn(executable, args, options);
  assert.equal(
    result.status,
    0,
    `${executable} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`
  );
  return result;
}
const helper = join(root, 'scripts/review-receipt.mjs');
const cli = (...args) => command(process.execPath, [helper, ...args]);
function fixtureRunner(path, mode, home = '') {
  cli('runner', home, path, mode, repo, '42', '1', '0', 'true', 'false', 'false', '', '');
}
function integration(directory, maxActive = 3) {
  const home = join(directory, 'coordinator');
  mkdirSync(home, { recursive: true });
  const manifest = {
    version: 1,
    runId: 'fixture-integration',
    worktree: repo,
    total: 6,
    maxActive,
    deadlineMs: 600000,
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
    sourceFingerprint: { sha256: 'fixture', files: ['input.txt'] },
  };
  json(join(home, 'manifest.json'), manifest);
  json(join(home, 'queue.json'), {
    maxActive,
    launched: [1, 2, 3, 4, 5, 6],
    cancelled: [],
    interrupted: false,
  });
  const paths = ['manifest.json', 'queue.json'];
  for (let shard = 1; shard <= 6; shard++) {
    const file = `shard-${shard}/runner.json`;
    json(join(home, file), {
      runId: manifest.runId,
      shard,
      exitCode: 0,
      cleanupSucceeded: true,
      timedOut: false,
    });
    paths.push(file);
  }
  json(
    join(home, 'artifact-index.json'),
    paths.map((file) => {
      const row = artifactRecord(join(home, file));
      return { file, bytes: row.bytes, sha256: row.sha256 };
    })
  );
  const receipt = {
    ...manifest,
    artifactDirectory: home,
    elapsedMs: 100,
    discoveryOnly: false,
    equivalencePassed: true,
    errors: [],
    success: true,
  };
  json(join(home, 'result.json'), receipt);
  json(join(directory, 'integration/shards.json'), receipt);
  fixtureRunner(join(directory, 'integration/runner.json'), 'shards');
}
function benchmarkReport(output, name) {
  const screenshot = `${output}.touch-portrait.png`;
  writeFileSync(screenshot, 'fixture screenshot');
  return {
    schemaVersion: 1,
    kind: 'realtime-client',
    status: 'passed',
    details: {
      cleanupComplete: true,
      failures: [],
      scenarios: [
        {
          scenario: { name: 'touch-portrait' },
          screenshot,
          status: 'passed',
          errors: [],
          warnings: [],
        },
      ],
    },
    measurement: {
      cleanup: 'complete',
      parameters: {
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
      },
    },
  };
}
function setupRun() {
  const directory = mkdtempSync(join(repo, '.performance/run-'));
  cli('start', directory, repo);
  return directory;
}
function complete(directory, maxActive = 3) {
  for (const name of ['integration', 'frame', 'traversal', 'combat']) {
    mkdirSync(join(directory, name));
    writeFileSync(join(directory, name, 'output.log'), `${name} passed\n`);
    if (name === 'integration') {
      integration(directory, maxActive);
    } else if (name === 'frame') {
      json(join(directory, 'frame-work.json'), {
        kind: 'frame-work',
        result: { frameWork: Array(120).fill({}), frameImageSha256: 'witness' },
      });
    } else {
      const output = join(
        directory,
        name === 'traversal' ? 'mobile-combined.json' : 'mobile-combat.json'
      );
      json(output, benchmarkReport(output, name));
      const home = join(directory, `${name}-runner`);
      mkdirSync(home);
      writeFileSync(join(home, 'proxy.log'), 'retained proxy\n');
      fixtureRunner(join(directory, name, 'runner.json'), 'benchmark-client', home);
    }
    cli('stage', directory, name, '0', ...reviewCommand(name, directory));
  }
  cli('finish', directory, '0', 'true');
  return join(directory, 'review.json');
}
function rejected(path, edit) {
  const original = readFileSync(path);
  try {
    edit();
    assert.throws(() => validateReviewReceipt(path));
  } finally {
    writeFileSync(path, original);
  }
}
try {
  command('git', ['init', '-q']);
  writeFileSync(join(repo, '.gitignore'), '.performance/\nlogs/\n');
  writeFileSync(join(repo, 'input.txt'), 'source\n');
  mkdirSync(join(repo, '.performance'));
  copyFileSync(helper, join(repo, 'scripts/review-receipt.mjs'));
  copyFileSync(
    join(root, 'scripts/integration-shard-plan.mjs'),
    join(repo, 'scripts/integration-shard-plan.mjs')
  );
  command('git', ['add', '.']);
  const path = complete(setupRun());
  for (const maxActive of [1, 2]) {
    const limited = validateReviewReceipt(complete(setupRun(), maxActive));
    assert.equal(limited.stages.length, 4);
  }
  for (const maxActive of [0, 4, 1.5, '2']) {
    assert.throws(() => complete(setupRun(), maxActive));
  }
  const before = readFileSync(path);
  const receipt = validateReviewReceipt(path);
  assert.equal(receipt.stages.length, 4);
  assert.deepEqual(readFileSync(path), before, 'Validator mutated receipt');
  const editReceipt = (mutate) => {
    const row = read(path);
    mutate(row);
    json(path, row);
  };
  rejected(path, () => editReceipt((row) => row.stages.pop()));
  rejected(path, () => editReceipt((row) => row.stages.reverse()));
  rejected(path, () => editReceipt((row) => row.stages[0].command.push('--retry=1')));
  rejected(path, () => editReceipt((row) => (row.retentionSucceeded = false)));
  rejected(path, () => editReceipt((row) => (row.success = false)));
  rejected(path, () => editReceipt((row) => (row.sourceIdentity.sha256 = 'stale')));
  const output = join(receipt.artifactDirectory, 'combat/output.log');
  writeFileSync(output, 'changed\n');
  assert.throws(() => validateReviewReceipt(path));
  writeFileSync(output, 'combat passed\n');
  const runner = join(receipt.artifactDirectory, 'combat/runner.json');
  const savedRunner = readFileSync(runner);
  json(runner, { ...read(runner), cleanupSucceeded: false });
  assert.throws(() => validateReviewReceipt(path));
  writeFileSync(runner, savedRunner);
  const screenshot = `${join(receipt.artifactDirectory, 'mobile-combat.json')}.touch-portrait.png`;
  const image = readFileSync(screenshot);
  rmSync(screenshot);
  assert.throws(() => validateReviewReceipt(path), 'Absent scenario screenshot accepted');
  writeFileSync(screenshot, 'changed screenshot');
  assert.throws(() => validateReviewReceipt(path), 'Changed scenario screenshot accepted');
  rmSync(screenshot);
  symlinkSync(output, screenshot);
  assert.throws(() => validateReviewReceipt(path), 'Symlink scenario screenshot accepted');
  rmSync(screenshot);
  writeFileSync(screenshot, image);
  const source = join(repo, 'input.txt');
  writeFileSync(source, 'different\n');
  assert.throws(() => validateReviewReceipt(path));
  validateReviewReceipt(path, { checkCurrentSource: false });
  writeFileSync(source, 'source\n');
  chmodSync(source, 0o755);
  assert.throws(() => validateReviewReceipt(path));
  chmodSync(source, 0o644);
  assert.deepEqual(reviewSourceIdentity(repo), receipt.sourceIdentity);
  validateReviewReceipt(path);
  const incomplete = setupRun();
  const failed = fixtureSpawn(process.execPath, [helper, 'finish', incomplete, '0', 'true'], {
    cwd: repo,
  });
  assert.notEqual(failed.status, 0);
  assert.equal(read(join(incomplete, 'review.json')).success, false);
  const session = join(scratch, 'session');
  mkdirSync(session);
  cli(
    'runner',
    '',
    join(scratch, 'failed-runner.json'),
    'benchmark-client',
    repo,
    '42',
    '1',
    '7',
    'false',
    'false',
    'true',
    session,
    'SIGTERM'
  );
  const failure = read(join(scratch, 'failed-runner.json'));
  assert.equal(failure.success, false);
  assert.equal(failure.cleanupSucceeded, false);
  assert.equal(failure.lockReleased, false);
  assert.equal(failure.sessionRemoved, false);
  // Exercise the actual review shell entry with private synthetic stage CLIs.
  copyFileSync(join(root, 'scripts/test-review.sh'), join(repo, 'scripts/test-review.sh'));
  const fixture = join(repo, 'scripts/fixture.mjs');
  writeFileSync(
    fixture,
    `
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { artifactRecord } from './review-receipt.mjs';
const repo = process.cwd();
const helper = join(repo, 'scripts/review-receipt.mjs');
const json = ${json.toString()};
const cli = (...args) => {
 const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
 env.GIT_CONFIG_GLOBAL = '/dev/null';
 env.GIT_CONFIG_SYSTEM = '/dev/null';
 env.GIT_CONFIG_NOSYSTEM = '1';
 const result = spawnSync(process.execPath, [helper, ...args], { stdio: 'inherit', env });
 if (result.status !== 0) process.exit(result.status ?? 1);
};
${fixtureRunner.toString()}
${integration.toString()}
${benchmarkReport.toString()}
const args = process.argv.slice(2);
const output = args[args.indexOf('--output') + 1];
const stage = args[0] === 'frame' ? 'frame' : args.includes('--shards=6') ? 'integration' : args[args.indexOf('--scenario') + 1];
if (process.env.GEOROIDS_STAGE_TRACE) appendFileSync(process.env.GEOROIDS_STAGE_TRACE, stage + '\\n');
process.stdout.write('diagnostic for ' + stage + '\\n');
if (args[0] === 'frame') {
 json(output, { kind: 'frame-work', result: { frameWork: Array(120).fill({}), frameImageSha256: 'image' } });
} else {
 const destination = process.env.GEOROIDS_TEST_RUNNER_RECEIPT;
 const directory = dirname(dirname(destination));
 if (args.includes('--shards=6')) integration(directory);
 else {
  const report = benchmarkReport(output, args[args.indexOf('--scenario') + 1]);
  const fault = process.env.GEOROIDS_REPORT_FAULT;
  if (fault === 'schema') report.schemaVersion = 999;
  if (fault === 'kind') report.kind = 'unknown';
  if (fault === 'status') report.status = 'failed';
  if (fault === 'validation') report.validationFailure = { message: 'failed' };
  if (fault === 'cleanup') report.details.cleanupComplete = false;
  if (fault === 'measurement-cleanup') report.measurement.cleanup = 'incomplete';
  if (fault === 'scenario-list') report.details.scenarios = [];
  if (fault === 'scenario-errors') report.details.scenarios[0].errors = ['failed'];
  if (fault === 'failure') report.details.failures.push({ message: 'failed' });
  if (fault === 'scenario') report.details.scenarios[0].status = 'failed';
  if (fault === 'workload') report.measurement.parameters.workload = 'other';
  if (fault === 'options') report.measurement.parameters.cpuSlowdown = 6;
  if (fault === 'screenshot') rmSync(report.details.scenarios[0].screenshot);
  if (fault === 'screenshot-symlink') {
   rmSync(report.details.scenarios[0].screenshot);
   symlinkSync(output, report.details.scenarios[0].screenshot);
  }
  json(output, report);
  fixtureRunner(destination, 'benchmark-client');
  mkdirSync('logs', { recursive: true });
  writeFileSync('logs/server.log', 'retained diagnostics');
 }
}
if (process.env.GEOROIDS_STAGE_FAILURE === stage) process.exit(23);
`
  );
  writeFileSync(
    join(repo, 'scripts/test-runner.sh'),
    '#!/usr/bin/env bash\nnode scripts/fixture.mjs "$@"\n'
  );
  chmodSync(join(repo, 'scripts/test-runner.sh'), 0o755);
  const bin = join(scratch, 'bin');
  mkdirSync(bin);
  writeFileSync(
    join(bin, 'node'),
    `#!/usr/bin/env bash
if [[ "\${1:-}" == --import ]]; then
 shift 3
 exec '${process.execPath}' '${fixture}' frame "$@"
fi
exec '${process.execPath}' "$@"
`
  );
  chmodSync(join(bin, 'node'), 0o755);
  writeFileSync(
    join(bin, 'cp'),
    `#!/usr/bin/env bash
if [[ "\${GEOROIDS_CONTRACT_RETENTION_FAIL:-}" == 1 && "\${*: -1}" == */combat/ ]]; then exit 1; fi
exec /bin/cp "$@"
`
  );
  chmodSync(join(bin, 'cp'), 0o755);
  const realTee = command('bash', ['-c', 'command -v tee']).stdout.trim();
  writeFileSync(
    join(bin, 'tee'),
    `#!/usr/bin/env bash
'${realTee}' "$@"
status=$?
if [[ "\${GEOROIDS_TEE_FAILURE:-}" == 1 ]]; then exit 24; fi
exit "$status"
`
  );
  chmodSync(join(bin, 'tee'), 0o755);
  const aggregate = join(scratch, 'aggregate.json');
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    GEOROIDS_REVIEW_RECEIPT: aggregate,
  };
  command('bash', ['scripts/test-review.sh'], { env });
  validateReviewReceipt(aggregate);
  const trace = join(scratch, 'stage-trace.txt');
  const orderedStages = ['integration', 'frame', 'traversal', 'combat'];
  function assertShellFailure(stage, teeFailure = false) {
    writeFileSync(trace, '');
    const failedRun = fixtureSpawn('bash', ['scripts/test-review.sh'], {
      env: {
        ...env,
        GEOROIDS_STAGE_TRACE: trace,
        ...(teeFailure ? { GEOROIDS_TEE_FAILURE: '1' } : { GEOROIDS_STAGE_FAILURE: stage }),
      },
    });
    assert.notEqual(
      failedRun.status,
      0,
      `Actual review CLI masked nonzero ${teeFailure ? 'tee' : stage} exit`
    );
    const failedReceipt = read(aggregate);
    assert.equal(failedReceipt.success, false);
    assert.notEqual(failedReceipt.exitCode, 0);
    assert.throws(
      () => validateReviewReceipt(aggregate),
      'Failed pipeline receipt remained reusable'
    );
    const expectedStages = orderedStages.slice(0, orderedStages.indexOf(stage) + 1);
    assert.deepEqual(
      readFileSync(trace, 'utf8').trim().split('\n'),
      expectedStages,
      'Later review stages ran after pipeline failure'
    );
    assert(
      readFileSync(join(failedReceipt.artifactDirectory, stage, 'output.log'), 'utf8').includes(
        `diagnostic for ${stage}`
      ),
      'Failed pipeline diagnostics were not retained'
    );
    const artifact =
      stage === 'integration'
        ? join(failedReceipt.artifactDirectory, stage, 'shards.json')
        : join(
            failedReceipt.artifactDirectory,
            stage === 'frame'
              ? 'frame-work.json'
              : stage === 'traversal'
                ? 'mobile-combined.json'
                : 'mobile-combat.json'
          );
    assert(
      readFileSync(artifact).length > 0,
      'Valid artifact written before failure was not retained'
    );
  }
  for (const stage of orderedStages) {
    assertShellFailure(stage);
  }
  assertShellFailure('integration', true);
  // This private mutation must trip the exact subprocess-exit contract above.
  const reviewShell = join(repo, 'scripts/test-review.sh');
  const originalReviewShell = readFileSync(reviewShell, 'utf8');
  assert(originalReviewShell.includes('set -euo pipefail'), 'Missing baseline pipefail protection');
  try {
    writeFileSync(reviewShell, originalReviewShell.replace('set -euo pipefail', 'set -eu'));
    assert.throws(
      () => assertShellFailure('integration'),
      /masked nonzero integration exit/u,
      'Contract accepted private no-pipefail mutant'
    );
  } finally {
    writeFileSync(reviewShell, originalReviewShell);
  }
  for (const fault of [
    'schema',
    'kind',
    'status',
    'validation',
    'cleanup',
    'measurement-cleanup',
    'scenario-list',
    'scenario-errors',
    'failure',
    'scenario',
    'workload',
    'options',
    'screenshot',
    'screenshot-symlink',
  ]) {
    const rejectedReport = fixtureSpawn('bash', ['scripts/test-review.sh'], {
      env: { ...env, GEOROIDS_REPORT_FAULT: fault },
    });
    assert.notEqual(
      rejectedReport.status,
      0,
      `Actual review CLI accepted benchmark fault: ${fault}`
    );
    const failureReceipt = read(aggregate);
    assert.equal(failureReceipt.success, false);
    assert.notEqual(failureReceipt.exitCode, 0);
    assert(failureReceipt.errors.length > 0);
    assert(
      readFileSync(join(failureReceipt.artifactDirectory, 'mobile-combined.json')).length > 0,
      'Failed report evidence was not retained'
    );
  }
  const retainedFailure = fixtureSpawn('bash', ['scripts/test-review.sh'], {
    cwd: repo,
    env: { ...env, GEOROIDS_CONTRACT_RETENTION_FAIL: '1' },
    encoding: 'utf8',
  });
  assert.notEqual(retainedFailure.status, 0, 'Final retention failure passed review');
  assert.equal(read(aggregate).success, false, 'Failed review left reusable success');
  if (!process.argv.includes('--hostile-child')) {
    const parent = join(scratch, 'hostile-parent');
    mkdirSync(parent);
    command('git', ['init', '-q'], { cwd: parent });
    writeFileSync(join(parent, 'parent.txt'), 'parent commit\n');
    command('git', ['add', 'parent.txt'], { cwd: parent });
    command(
      'git',
      [
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'user.name=Contract',
        '-c',
        'user.email=contract@example.invalid',
        'commit',
        '-qm',
        'fixture parent',
      ],
      { cwd: parent }
    );
    writeFileSync(join(parent, 'parent.txt'), 'parent staged change\n');
    command('git', ['add', 'parent.txt'], { cwd: parent });
    const parentState = () =>
      ['HEAD', 'config', 'index'].map((file) => readFileSync(join(parent, '.git', file)));
    const beforeParent = parentState();
    const hostileHome = join(scratch, 'hostile-home');
    mkdirSync(hostileHome);
    writeFileSync(join(hostileHome, '.gitconfig'), '[core]\n hooksPath = /untrusted\n');
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--hostile-child'], {
      cwd: parent,
      encoding: 'utf8',
      env: {
        ...inheritedEnvironment,
        HOME: hostileHome,
        XDG_CONFIG_HOME: hostileHome,
        GIT_DIR: join(parent, '.git'),
        GIT_WORK_TREE: parent,
        GIT_INDEX_FILE: join(parent, '.git/index'),
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'core.repositoryformatversion',
        GIT_CONFIG_VALUE_0: '999',
        GIT_CONFIG_GLOBAL: join(hostileHome, '.gitconfig'),
      },
    });
    assert.equal(
      child.status,
      0,
      `Hostile Git environment broke isolated fixture\n${child.stdout}\n${child.stderr}`
    );
    assert.deepEqual(
      parentState(),
      beforeParent,
      'Private fixture mutated parent HEAD/config/index'
    );
  }
  process.stdout.write(
    'Review receipt contracts passed: four ordered stages, cleanup, source, retained digests and failure retention\n'
  );
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
