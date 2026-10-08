import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import test, { after } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { runGate } from './gate.mjs';
import { candidateMatches, digest, fileRecord, STAGES, sourceRows } from './gate-receipt.mjs';
import { canonicalEnvironment, lifecycleCommand } from './gate-runtime.mjs';
import { literalOnlyChange } from './literal-only-change.mjs';

// This file runs in a dedicated node:test process. Isolate every fixture Git
// call, including production helpers under test, from a committing parent's
// exported index/repository/config and from the user's global configuration.
const fixtureHome = mkdtempSync(join(tmpdir(), 'georoids-gate-home-'));
for (const key of Object.keys(process.env)) {
  if (key.startsWith('GIT_')) {
    delete process.env[key];
  }
}
process.env.HOME = fixtureHome;
process.env.XDG_CONFIG_HOME = join(fixtureHome, 'xdg');
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';
after(() => rmSync(fixtureHome, { recursive: true, force: true }));

// Independent acceptance contract: never derive this battery from STAGES.
const REQUIRED_COMMANDS = [
  'check:lint-policy',
  'check:lint',
  'check:knip',
  'check:ts-prune',
  'check:md',
  'check:yaml',
  'check:actions',
  'check:test-runner',
  'check:dev-server',
  'check:ts',
  'check:benchmarks',
  'test',
  'build',
  'test:review',
];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'georoids-gate-contract-'));
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };
  git('init', '-q');
  writeFileSync(join(root, '.gitignore'), '.performance/\n');
  writeFileSync(join(root, 'data.ts'), 'export const tuning = { speed: 2, enabled: true };\n');
  git('add', '.');
  let installation = 'installed';
  let runtime = 'runtime';
  let buildHead = 'a'.repeat(40);
  const capture = () => {
    const source = sourceRows(root);
    return {
      source,
      sourceDigest: digest(JSON.stringify(source)),
      installation,
      runtime,
      buildHead,
      reusable: true,
      manifest: digest(JSON.stringify(STAGES)),
    };
  };
  const calls = [];
  const run = (_, args, options) => {
    calls.push(args[1]);
    writeFileSync(options.artifact, 'passed\n');
    if (args[1] === 'test:review') {
      writeFileSync(options.env.GEOROIDS_REVIEW_RECEIPT, '{"cleanupSucceeded":true}');
    }
    return { status: 0, stdout: 'passed\n', stderr: '' };
  };
  const validateReview = (path) => {
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).cleanupSucceeded, true);
  };
  const gate = () =>
    runGate({
      root,
      capture,
      run,
      validateReview,
      prepare: () => ({ status: 0, stdout: 'fixture tool preparation' }),
      environment: {},
    });
  return {
    root,
    git,
    calls,
    gate,
    capture,
    run,
    validateReview,
    buildHead: (value = 'b'.repeat(40)) => {
      buildHead = value;
    },
    installation: () => {
      installation += 'changed';
    },
    runtime: () => {
      runtime += 'changed';
    },
  };
}
test('complete proof reuses only exact candidate and retained successful artifacts', async () => {
  const f = fixture();
  try {
    const first = await f.gate();
    assert.deepEqual(
      f.calls,
      STAGES.map(([, command]) => command)
    );
    f.calls.length = 0;
    await f.gate();
    assert.deepEqual(f.calls, []);
    writeFileSync(first.stages[0].artifact, 'corrupt');
    await f.gate();
    assert.equal(f.calls.length, STAGES.length);
    f.calls.length = 0;
    f.installation();
    await f.gate();
    assert.equal(f.calls.length, STAGES.length);
    f.calls.length = 0;
    f.runtime();
    await f.gate();
    assert.equal(f.calls.length, STAGES.length);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
test('committing the already verified source reuses code checks and executes a build for the new HEAD', async () => {
  const f = fixture();
  try {
    const original = await f.gate();
    f.buildHead();
    f.calls.length = 0;
    const committed = await f.gate();
    assert.deepEqual(f.calls, ['build']);
    assert.equal(committed.identity.buildHead, 'b'.repeat(40));
    assert.equal(committed.stages.find((stage) => stage.command === 'build').kind, 'ran');
    for (const stage of committed.stages.filter((row) => row.command !== 'build')) {
      assert.equal(stage.kind, 'head-reuse');
      assert.equal(
        stage.artifact,
        original.stages.find((row) => row.command === stage.command).artifact
      );
      assert.equal(
        stage.digest,
        original.stages.find((row) => row.command === stage.command).digest
      );
      assert.equal(stage.provenance.buildHead, 'a'.repeat(40));
    }
    f.calls.length = 0;
    await f.gate();
    assert.deepEqual(f.calls, [], 'complete new-head receipt is reusable');
    f.buildHead('c'.repeat(40));
    const later = await f.gate();
    assert.deepEqual(f.calls, ['build']);
    for (const row of later.stages.filter((item) => item.kind === 'head-reuse')) {
      const earlier = committed.stages.find((item) => item.command === row.command);
      assert.deepEqual(row.provenance, earlier.provenance, 'reuse keeps the fully executed origin');
    }
    f.buildHead('a'.repeat(40));
    f.calls.length = 0;
    await f.gate();
    assert.deepEqual(f.calls, ['build'], 'returning to the original HEAD still rebuilds its stamp');
    f.calls.length = 0;
    await f.gate();
    assert.deepEqual(f.calls, [], 'the round-trip receipt retains valid executed origins');
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('new-head reuse refuses changed execution inputs, damaged donor evidence and a failed build', async () => {
  for (const changed of ['source', 'installation', 'runtime', 'unknown', 'cleanup']) {
    const f = fixture();
    try {
      const validated = await f.gate();
      f.buildHead();
      if (changed === 'source') {
        writeFileSync(join(f.root, 'data.ts'), 'export const changedShape = true;');
        f.git('add', 'data.ts');
      } else if (changed === 'cleanup') {
        writeFileSync(validated.reviewReceipt, '{"cleanupSucceeded":false}');
      } else if (changed === 'unknown') {
        const capture = f.capture;
        f.capture = () => ({ ...capture(), reusable: false, unknown: ['UNCLASSIFIED'] });
      } else {
        f[changed]();
      }
      f.calls.length = 0;
      await runGate({
        root: f.root,
        capture: f.capture,
        run: f.run,
        validateReview: f.validateReview,
        prepare: () => ({ status: 0 }),
        environment: {},
      });
      assert.deepEqual(f.calls, REQUIRED_COMMANDS, changed);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  }
  const f = fixture();
  try {
    await f.gate();
    f.buildHead();
    const path = join(f.root, '.performance/gate/receipt.json');
    const prior = readFileSync(path, 'utf8');
    f.calls.length = 0;
    await assert.rejects(
      () =>
        runGate({
          root: f.root,
          capture: f.capture,
          run: (_, args, options) => {
            f.calls.push(args[1]);
            writeFileSync(options.artifact, 'actual failed new-head build');
            return { status: 7 };
          },
          validateReview: f.validateReview,
          prepare: () => ({ status: 0 }),
          environment: {},
        }),
      /failed/u
    );
    assert.deepEqual(f.calls, ['build']);
    assert.equal(
      readFileSync(path, 'utf8'),
      prior,
      'failed build cannot publish a new-head success'
    );
    f.calls.length = 0;
    const committed = await f.gate();
    assert.deepEqual(f.calls, ['build'], 'retry still executes the failed build');
    const proof = committed.stages.find((row) => row.kind === 'head-reuse').provenance.receipt;
    writeFileSync(proof, 'damaged complete donor evidence');
    f.calls.length = 0;
    await f.gate();
    assert.deepEqual(f.calls, REQUIRED_COMMANDS, 'damaged origin cannot certify reused stages');
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('new-head reuse refuses late index mutation or loss of retained donor evidence', async () => {
  for (const fault of ['index', 'artifact']) {
    const f = fixture();
    try {
      const old = await f.gate();
      f.buildHead();
      const prior = readFileSync(join(f.root, '.performance/gate/receipt.json'), 'utf8');
      await assert.rejects(
        () =>
          runGate({
            root: f.root,
            capture: f.capture,
            run: (_, args, options) => {
              assert.equal(args[1], 'build');
              writeFileSync(options.artifact, 'new-head build completed');
              if (fault === 'index') {
                f.git('rm', '--cached', 'data.ts');
              } else {
                writeFileSync(old.stages[0].artifact, 'damaged during build');
              }
              return { status: 0 };
            },
            validateReview: f.validateReview,
            prepare: () => ({ status: 0 }),
            environment: {},
          }),
        fault === 'index' ? /Candidate index changed/u : /donor evidence changed/u
      );
      assert.equal(readFileSync(join(f.root, '.performance/gate/receipt.json'), 'utf8'), prior);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  }
});

test('a newer failed or interrupted code attempt blocks an older pass until fresh code validation', async () => {
  for (const outcome of [
    { status: 1 },
    { status: null, signal: 'SIGTERM' },
    new Error('owned stage setup interrupted'),
  ]) {
    const f = fixture();
    try {
      await f.gate();
      if (!(outcome instanceof Error)) {
        f.buildHead();
      }
      f.git('rm', '--cached', 'data.ts');
      const receiptPath = join(f.root, '.performance/gate/receipt.json');
      const old = readFileSync(receiptPath, 'utf8');
      await assert.rejects(
        () =>
          runGate({
            root: f.root,
            capture: f.capture,
            run: (_, args, options) => {
              if (args[1] === 'test') {
                writeFileSync(options.artifact, 'newer unit failure or interruption');
                if (outcome instanceof Error) {
                  throw outcome;
                }
                return outcome;
              }
              return f.run(_, args, options);
            },
            validateReview: f.validateReview,
            prepare: () => ({ status: 0 }),
            environment: {},
          }),
        /Gate vitest failed|owned stage setup interrupted/u
      );
      assert.equal(readFileSync(receiptPath, 'utf8'), old, 'retain the old pass for diagnostics');
      f.git('add', 'data.ts');
      // An unrelated failed scope must not erase the earlier failure marker.
      f.installation();
      await assert.rejects(
        () =>
          runGate({
            root: f.root,
            capture: f.capture,
            run: () => ({ status: 3 }),
            validateReview: f.validateReview,
            prepare: () => ({ status: 0 }),
            environment: {},
          }),
        /failed/u
      );
      const capture = f.capture;
      const originalInstallation = JSON.parse(old).identity.installation;
      const retryOptions = {
        root: f.root,
        capture: () => ({ ...capture(), installation: originalInstallation }),
        run: f.run,
        validateReview: f.validateReview,
        prepare: () => ({ status: 0 }),
        environment: {},
      };
      f.calls.length = 0;
      await runGate(retryOptions);
      assert.deepEqual(
        f.calls,
        REQUIRED_COMMANDS,
        'fresh code evidence supersedes the failed attempt'
      );
      f.calls.length = 0;
      await runGate(retryOptions);
      assert.deepEqual(f.calls, [], 'the newly complete pass remains reusable');
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  }
});

test('literal tuning skips only graphs while partial staging never certifies candidate', async () => {
  const f = fixture();
  try {
    await f.gate();
    f.calls.length = 0;
    writeFileSync(join(f.root, 'data.ts'), 'export const tuning = { speed: 3, enabled: false };\n');
    const result = await f.gate();
    assert.equal(result.candidateCertified, false);
    assert.deepEqual(
      f.calls,
      STAGES.filter(([, command]) => !['check:knip', 'check:ts-prune'].includes(command)).map(
        ([, command]) => command
      )
    );
    f.calls.length = 0;
    await f.gate();
    assert.ok(f.calls.includes('test:review'));
    f.git('add', '.');
    f.calls.length = 0;
    await f.gate();
    assert.deepEqual(f.calls, []);
    chmodSync(join(f.root, 'data.ts'), 0o755);
    assert.equal(candidateMatches(f.root, sourceRows(f.root)), false);
    f.calls.length = 0;
    await f.gate();
    assert.ok(f.calls.includes('check:knip'));
    writeFileSync(join(f.root, 'extra.ts'), 'export const extra = 1;');
    assert.equal(candidateMatches(f.root, sourceRows(f.root)), false);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
test('failed or cancelled stage and incomplete cleanup never replace successful receipt', async () => {
  const f = fixture();
  try {
    await f.gate();
    f.installation();
    const path = join(f.root, '.performance/gate/receipt.json');
    const prior = readFileSync(path, 'utf8');
    for (const outcome of [{ status: 1 }, { status: null, signal: 'SIGTERM' }]) {
      await assert.rejects(
        () =>
          runGate({
            root: f.root,
            capture: f.capture,
            run: () => outcome,
            validateReview: f.validateReview,
            prepare: () => ({ status: 0, stdout: 'fixture tool preparation' }),
            environment: {},
          }),
        /failed/u
      );
      assert.equal(readFileSync(path, 'utf8'), prior);
    }
    await assert.rejects(
      () =>
        runGate({
          root: f.root,
          capture: f.capture,
          run: f.run,
          validateReview: () => {
            throw new Error('cleanup incomplete');
          },
          prepare: () => ({ status: 0, stdout: 'fixture tool preparation' }),
          environment: {},
        }),
      /cleanup incomplete/u
    );
    assert.equal(readFileSync(path, 'utf8'), prior);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
test('queued stage reports progress before completion and retains failed subprocess output', async () => {
  const f = fixture();
  let child;
  try {
    await f.gate();
    f.installation();
    const receiptPath = join(f.root, '.performance/gate/receipt.json');
    const prior = readFileSync(receiptPath, 'utf8');
    const bin = join(f.root, 'bin');
    mkdirSync(bin);
    const release = join(f.root, 'release');
    const completed = join(f.root, 'completed');
    writeFileSync(
      join(bin, 'npm'),
      `#!${process.execPath}
import { existsSync, writeFileSync } from 'node:fs';
process.stdout.write('private stdout diagnostics\\nReview artifacts: fixture-review\\n');
process.stderr.write('private stderr diagnostics\\nWaiting for heavy validation ticket allocation: fixture-allocation\\nWaiting for heavy validation admission,');
setTimeout(() => process.stderr.write(' ticket fixture: fixture-queue\\n'), 10);
const timer = setInterval(() => {
  if (existsSync(${JSON.stringify(release)})) {
    clearInterval(timer);
    writeFileSync(${JSON.stringify(completed)}, 'finished');
    process.stdout.write('last stdout diagnostics\\n');
    process.stderr.write('last stderr diagnostics\\n');
    process.exitCode = 7;
  }
}, 10);
setTimeout(() => process.exit(8), 5000).unref();
`,
      { mode: 0o755 }
    );
    child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { runGate } from ${JSON.stringify(new URL('./gate.mjs', import.meta.url).href)};
try {
  await runGate({
    root: ${JSON.stringify(f.root)},
    capture: () => (${JSON.stringify(f.capture())}),
    prepare: () => ({status: 0}),
    environment: {...process.env, PATH: ${JSON.stringify(bin)}}
  });
} catch (error) { console.error(error.message); process.exitCode = 1; }
`,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'], detached: true }
    );
    const finished = new Promise((accept, reject) => {
      child.once('error', reject);
      child.once('close', (status, signal) => accept({ status, signal }));
    });
    let output = '';
    let progress;
    const reported = new Promise((accept) => {
      progress = accept;
    });
    const report = (chunk) => {
      output += chunk;
      if (
        output.includes('Waiting for heavy validation admission, ticket fixture: fixture-queue') &&
        output.includes('Review artifacts: fixture-review') &&
        output.includes('Waiting for heavy validation ticket allocation: fixture-allocation')
      ) {
        progress(true);
      }
    };
    child.stdout.on('data', report);
    child.stderr.on('data', report);
    assert.equal(await Promise.race([reported, finished.then(() => false)]), true, output);
    assert.equal(existsSync(completed), false);
    assert.doesNotMatch(output, /private (?:stdout|stderr) diagnostics/u);
    writeFileSync(release, 'continue');
    assert.deepEqual(await finished, { status: 1, signal: null });
    assert.match(output, /failed \(7\); diagnostics:/u);
    const artifact = output.match(/diagnostics: (.+\.log)/u)?.[1];
    assert.ok(artifact, output);
    const log = readFileSync(artifact, 'utf8');
    for (const line of [
      'private stdout diagnostics',
      'private stderr diagnostics',
      'last stdout diagnostics',
      'last stderr diagnostics',
      'Waiting for heavy validation ticket allocation: fixture-allocation',
      'Waiting for heavy validation admission, ticket fixture: fixture-queue',
      'Review artifacts: fixture-review',
    ]) {
      assert.ok(log.includes(line), line);
    }
    assert.equal(readFileSync(receiptPath, 'utf8'), prior);
  } finally {
    if (child?.exitCode === null && child.pid) {
      process.kill(-child.pid, 'SIGKILL');
    }
    rmSync(f.root, { recursive: true, force: true });
  }
});
test('classifier freezes symbols, shape, module strings, and unknown string use', () => {
  const check = (a, b) => literalOnlyChange({ 'data.ts': a }, { 'data.ts': b });
  assert.equal(check('export const a={speed:1};', 'export const a={speed:2};'), true);
  for (const [a, b] of [
    ['const a=1;', 'const b=1;'],
    ['const a={x:1};', 'const a={y:1};'],
    ['import("a")', 'import("b")'],
    ['const a="module-a";', 'const a="module-b";'],
    ['const a=foo(1);', 'const a=foo(2);'],
    ['const a=1;', 'const a=1+1;'],
  ]) {
    assert.equal(check(a, b), false);
  }
  assert.equal(literalOnlyChange({ 'package.json': '{}' }, { 'package.json': '{"a":1}' }), false);
});
test('installed payload identity records executable mode and symlink contents', () => {
  const root = mkdtempSync(join(tmpdir(), 'georoids-payload-contract-'));
  try {
    mkdirSync(join(root, 'node_modules'));
    const path = join(root, 'node_modules/tool');
    writeFileSync(path, 'payload');
    const before = fileRecord(path);
    chmodSync(path, 0o755);
    assert.notDeepEqual(fileRecord(path), before);
    writeFileSync(path, 'different');
    assert.notEqual(fileRecord(path).digest, before.digest);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('real identity covers installed bytes, ignored env, tool bytes, and unknown overrides', async () => {
  const { identity } = await import('./gate-receipt.mjs');
  const f = fixture();
  try {
    mkdirSync(join(f.root, 'bin'));
    mkdirSync(join(f.root, 'node_modules'));
    for (const name of ['npm', 'bash', 'git', 'uvx']) {
      writeFileSync(join(f.root, 'bin', name), name, { mode: 0o755 });
    }
    writeFileSync(
      join(f.root, 'bin', 'npm'),
      `console.log('userconfig='+(process.env.npm_config_userconfig || process.env.HOME+'/.npmrc')); console.log('globalconfig='+(process.env.npm_config_globalconfig || process.env.HOME+'/etc/npmrc'));`,
      { mode: 0o755 }
    );
    writeFileSync(join(f.root, '.gitignore'), '.performance/\nnode_modules/\nbin/\n.env.local\n');
    const payload = join(f.root, 'node_modules', 'native.node');
    writeFileSync(payload, 'native payload');
    writeFileSync(join(f.root, '.env.local'), 'SECRET=one');
    const env = {
      PATH: join(f.root, 'bin'),
      HOME: fixtureHome,
    };
    const first = identity(f.root, env);
    writeFileSync(payload, 'changed native payload');
    assert.notEqual(identity(f.root, env).installation, first.installation);
    writeFileSync(join(f.root, '.env.local'), 'SECRET=two');
    const second = identity(f.root, env);
    assert.notEqual(second.runtime, first.runtime);
    assert.equal(JSON.stringify(second).includes('SECRET=two'), false);
    writeFileSync(join(f.root, 'bin', 'bash'), 'new executable');
    assert.notEqual(identity(f.root, env).runtime, second.runtime);
    assert.equal(identity(f.root, { ...env, GEOROIDS_UNKNOWN_OVERRIDE: '1' }).reusable, false);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('manifest tampering, missing receipts and final source mutation fail closed', async () => {
  const f = fixture();
  try {
    await f.gate();
    const path = join(f.root, '.performance/gate/receipt.json');
    const receipt = JSON.parse(readFileSync(path, 'utf8'));
    receipt.stages.reverse();
    writeFileSync(path, JSON.stringify(receipt));
    f.calls.length = 0;
    await f.gate();
    assert.equal(f.calls.length, STAGES.length);
    const current = JSON.parse(readFileSync(path, 'utf8'));
    rmSync(current.reviewReceipt);
    f.calls.length = 0;
    await f.gate();
    assert.equal(f.calls.length, STAGES.length);
    f.installation();
    const prior = readFileSync(path, 'utf8');
    const mutate = (...args) => {
      const result = f.run(...args);
      if (args[1][1] === 'build') {
        writeFileSync(join(f.root, 'data.ts'), 'const changed=123;');
      }
      return result;
    };
    await assert.rejects(
      () =>
        runGate({
          root: f.root,
          capture: f.capture,
          run: mutate,
          validateReview: f.validateReview,
          prepare: () => ({ status: 0, stdout: 'fixture tool preparation' }),
          environment: {},
        }),
      /inputs changed/u
    );
    assert.equal(readFileSync(path, 'utf8'), prior);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('manual and substantive commit hook dispatch one complete entry without duplication', () => {
  const root = mkdtempSync(join(tmpdir(), 'georoids-hook-contract-'));
  try {
    mkdirSync(join(root, '.git-hooks'));
    mkdirSync(join(root, 'scripts'));
    writeFileSync(
      join(root, '.git-hooks/pre-commit'),
      readFileSync(new URL('../.git-hooks/pre-commit', import.meta.url))
    );
    const calls = join(root, 'calls');
    const library = join(root, 'gate-lib.sh');
    writeFileSync(
      library,
      `gate_enter_committing_tree() { cd "$FIXTURE_ROOT"; }
gate_require_lib() { printf 'lib:%s\\n' "$1" >> "$CALLS"; }
gate_begin_commit() { printf 'preamble:%s\\n' "$FLEET_DOC_FAST" >> "$CALLS"; }
gate_check_bash_floor() { :; }
gate_require_node() { printf 'node-floor\\n' >> "$CALLS"; }
run_step() { printf 'step:%s\\n' "$1" >> "$CALLS"; shift; "$@"; }
`
    );
    writeFileSync(
      join(root, 'scripts/gate.mjs'),
      "import{appendFileSync}from'node:fs';appendFileSync(process.env.CALLS,'core\\n');"
    );
    for (const forced of ['0', '1']) {
      writeFileSync(calls, '');
      const result = spawnSync('bash', ['.git-hooks/pre-commit'], {
        cwd: root,
        env: {
          ...process.env,
          DOTAGENTS_GATE_LIB: library,
          FIXTURE_ROOT: root,
          CALLS: calls,
          FLEET_DOC_FAST: forced,
        },
        encoding: 'utf8',
      });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(readFileSync(calls, 'utf8').trim().split('\n'), [
        'lib:12',
        `preamble:${forced}`,
        'step:bash floor',
        'node-floor',
        'core',
      ]);
    }
    const packageJson = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8')
    );
    assert.equal(packageJson.scripts.gate, 'FLEET_DOC_FAST=0 bash .git-hooks/pre-commit');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('staging a deletion preserves working content identity but changes candidate parity', () => {
  const f = fixture();
  try {
    rmSync(join(f.root, 'data.ts'));
    const before = sourceRows(f.root);
    assert.equal(candidateMatches(f.root, before), false);
    f.git('add', '-u');
    assert.deepEqual(sourceRows(f.root), before);
    assert.equal(candidateMatches(f.root, before), true);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('every gate stage writes generated caches in its issued artifact session', async () => {
  const f = fixture();
  try {
    const sessions = [];
    const cacheRunner = (...args) => {
      const options = args[2];
      const session = options.env.GEOROIDS_TEST_SESSION_DIR;
      assert.match(session, /\.performance\/gate\/run\.[^/]+\/session-\d+$/u);
      assert.equal(session.startsWith(`${f.root}/`), true);
      sessions.push(session);
      mkdirSync(join(session, 'cache'), { recursive: true });
      writeFileSync(join(session, 'cache', 'generated'), args[1][1]);
      return f.run(...args);
    };
    const receipt = await runGate({
      root: f.root,
      capture: f.capture,
      run: cacheRunner,
      validateReview: f.validateReview,
      prepare: () => ({ status: 0, stdout: 'fixture tool preparation' }),
      environment: {},
    });
    assert.equal(new Set(sessions).size, STAGES.length);
    assert.equal(receipt.identity.sourceDigest, f.capture().sourceDigest);
    f.calls.length = 0;
    await runGate({
      root: f.root,
      capture: f.capture,
      run: cacheRunner,
      validateReview: f.validateReview,
      prepare: () => ({ status: 0, stdout: 'fixture tool preparation' }),
      environment: {},
    });
    assert.deepEqual(f.calls, []);
    assert.equal(sessions.length, STAGES.length);
    for (const config of ['../vite.config.ts', '../vitest.config.ts']) {
      assert.match(
        readFileSync(new URL(config, import.meta.url), 'utf8'),
        /GEOROIDS_TEST_SESSION_DIR/u
      );
    }
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('hostile inherited Git repository, index and config never affect parent state', {
  skip: process.env.GEOROIDS_GATE_HOSTILE_CHILD === '1',
}, () => {
  const f = fixture();
  try {
    f.git('config', '--local', 'fixture.guard', 'original');
    f.git(
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      '-c',
      'core.hooksPath=/dev/null',
      'commit',
      '-qm',
      'fixture'
    );
    const tracked = ['HEAD', 'index', 'config'].map((name) => [
      name,
      readFileSync(join(f.root, '.git', name)),
    ]);
    const childEnvironment = { ...process.env };
    delete childEnvironment.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, ['--test', fileURLToPath(import.meta.url)], {
      env: {
        ...childEnvironment,
        GEOROIDS_GATE_HOSTILE_CHILD: '1',
        GIT_DIR: join(f.root, '.git'),
        GIT_WORK_TREE: f.root,
        GIT_INDEX_FILE: join(f.root, '.git/index'),
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'fixture.guard',
        GIT_CONFIG_VALUE_0: 'hostile',
        GIT_CONFIG_GLOBAL: join(f.root, '.git/config'),
      },
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /every gate stage writes generated caches/u);
    for (const [name, bytes] of tracked) {
      assert.deepEqual(readFileSync(join(f.root, '.git', name)), bytes);
    }
    assert.equal(
      readFileSync(join(f.root, 'data.ts'), 'utf8'),
      'export const tuning = { speed: 2, enabled: true };\n'
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('changed TypeScript symlink plus literal tuning requires both graph checks', async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, 'a.ts'), 'export const a=1;');
    writeFileSync(join(f.root, 'b.ts'), 'export const b=1;');
    symlinkSync('a.ts', join(f.root, 'linked.ts'));
    f.git('add', '.');
    await f.gate();
    unlinkSync(join(f.root, 'linked.ts'));
    symlinkSync('b.ts', join(f.root, 'linked.ts'));
    writeFileSync(join(f.root, 'data.ts'), 'export const tuning = { speed: 3, enabled: true };\n');
    f.calls.length = 0;
    await f.gate();
    assert.ok(f.calls.includes('check:knip'));
    assert.ok(f.calls.includes('check:ts-prune'));
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('cache-hit final boundary rejects index-only candidate mutation', async () => {
  const f = fixture();
  try {
    await f.gate();
    let captures = 0;
    f.calls.length = 0;
    const capture = () => {
      const value = f.capture();
      if (++captures === 2) {
        f.git('rm', '--cached', 'data.ts');
      }
      return value;
    };
    await assert.rejects(
      () =>
        runGate({
          root: f.root,
          capture,
          run: f.run,
          validateReview: f.validateReview,
          prepare: () => ({ status: 0, stdout: 'fixture tool preparation' }),
          environment: {},
        }),
      /inputs changed/u
    );
    assert.deepEqual(f.calls, []);
    assert.equal(candidateMatches(f.root, f.capture().source), false);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('malformed graph skip, classifier and witness metadata always force complete rerun', async () => {
  const f = fixture();
  try {
    await f.gate();
    const path = join(f.root, '.performance/gate/receipt.json');
    const original = readFileSync(path, 'utf8');
    const mutations = [
      (r) => {
        for (const stage of r.stages) {
          stage.kind = 'literal-graph';
        }
        delete r.classifier;
        delete r.graphWitness;
      },
      (r) => {
        r.stages[2].kind = 'literal-graph';
      },
      (r) => {
        delete r.classifier;
      },
      (r) => {
        r.graphArtifacts[0].witness = '0'.repeat(64);
      },
      (r) => {
        r.graphArtifacts[0].command = 'test';
      },
      (r) => {
        r.classifier = { kind: 'literal-only', witness: r.graphWitness };
      },
    ];
    for (const mutation of mutations) {
      const receipt = JSON.parse(original);
      mutation(receipt);
      writeFileSync(path, JSON.stringify(receipt));
      f.calls.length = 0;
      await f.gate();
      assert.equal(f.calls.length, STAGES.length);
    }
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('actual identity hashes hosted SHAs, npm config and resolved consumed file links', async () => {
  const { identity } = await import('./gate-receipt.mjs');
  const f = fixture();
  const external = mkdtempSync(join(tmpdir(), 'georoids-consumed-'));
  try {
    for (const name of ['bin', 'node_modules', 'home', 'home/etc']) {
      mkdirSync(join(f.root, name), { recursive: true });
    }
    for (const name of ['bash', 'git', 'uvx']) {
      writeFileSync(join(f.root, 'bin', name), name, { mode: 0o755 });
    }
    writeFileSync(
      join(f.root, 'bin/npm'),
      `console.log('userconfig='+(process.env.npm_config_userconfig||process.env.HOME+'/.npmrc'));console.log('globalconfig='+(process.env.npm_config_globalconfig||process.env.HOME+'/etc/npmrc'));`,
      { mode: 0o755 }
    );
    writeFileSync(
      join(f.root, '.gitignore'),
      '.performance/\nnode_modules/\nbin/\nhome/\n.env.local\n'
    );
    const env = {
      PATH: join(f.root, 'bin'),
      HOME: join(f.root, 'home'),
    };
    const first = identity(f.root, env);
    f.git('add', '.');
    f.git(
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      '-c',
      'core.hooksPath=/dev/null',
      'commit',
      '-qm',
      'first build HEAD'
    );
    const committed = identity(f.root, env);
    assert.equal(committed.runtime, first.runtime);
    assert.notEqual(committed.buildHead, first.buildHead);
    assert.deepEqual(committed.source, first.source);
    f.git(
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      '-c',
      'core.hooksPath=/dev/null',
      'commit',
      '--allow-empty',
      '-qm',
      'second build HEAD'
    );
    assert.equal(identity(f.root, env).runtime, committed.runtime);
    assert.notEqual(identity(f.root, env).buildHead, committed.buildHead);
    for (const key of ['VERCEL_GIT_COMMIT_SHA', 'RAILWAY_GIT_COMMIT_SHA']) {
      assert.notEqual(identity(f.root, { ...env, [key]: '123' }).runtime, first.runtime);
    }
    const configs = [join(f.root, 'home/.npmrc'), join(f.root, 'home/etc/npmrc')];
    for (const path of configs) {
      const before = identity(f.root, env);
      writeFileSync(path, 'script-shell=/private/shell');
      assert.notEqual(identity(f.root, env).runtime, before.runtime);
    }
    const selected = join(external, 'npmrc');
    writeFileSync(selected, 'script-shell=/selected/one');
    const chosen = { ...env, npm_config_userconfig: selected };
    const selectedBefore = identity(f.root, chosen);
    writeFileSync(selected, 'script-shell=/selected/two');
    assert.notEqual(identity(f.root, chosen).runtime, selectedBefore.runtime);
    const tool = join(external, 'tool');
    writeFileSync(tool, 'one', { mode: 0o755 });
    symlinkSync(tool, join(f.root, 'node_modules/tool'));
    mkdirSync(join(f.root, 'node_modules/canonical'));
    writeFileSync(join(f.root, 'node_modules/canonical/payload'), 'canonical one');
    symlinkSync('canonical', join(f.root, 'node_modules/alias'));
    symlinkSync('..', join(f.root, 'node_modules/canonical/cycle'));
    const aliasBefore = identity(f.root, env);
    writeFileSync(join(f.root, 'node_modules/canonical/payload'), 'canonical two');
    assert.notEqual(identity(f.root, env).installation, aliasBefore.installation);
    symlinkSync('../canonical', join(f.root, 'node_modules/canonical/self'));
    assert.equal(identity(f.root, env).reusable, true);
    const linked = identity(f.root, env);
    writeFileSync(tool, 'two', { mode: 0o755 });
    assert.notEqual(identity(f.root, env).installation, linked.installation);
    const secret = join(external, 'env');
    writeFileSync(secret, 'PRIVATE=one');
    symlinkSync(secret, join(f.root, '.env.local'));
    const envBefore = identity(f.root, env);
    writeFileSync(secret, 'PRIVATE=two');
    const envAfter = identity(f.root, env);
    assert.notEqual(envAfter.runtime, envBefore.runtime);
    assert.equal(JSON.stringify(envAfter).includes('PRIVATE=two'), false);
    symlinkSync(external, join(f.root, 'node_modules/directory'));
    assert.throws(() => identity(f.root, env), /Unsupported installed directory link/u);
    unlinkSync(join(f.root, 'node_modules/directory'));
    assert.equal(
      identity(f.root, {
        ...env,
        npm_config_allow_scripts: 'a',
        npm_config_noproxy: 'localhost',
        npm_config_yes: 'true',
        npm_config_loglevel: 'silent',
      }).reusable,
      true
    );
    assert.equal(identity(f.root, { ...env, npm_config_unclassified: 'x' }).reusable, false);
    const biome = identity(f.root, {
      ...env,
      BIOME_CONFIG_PATH: join(external, 'missing-policy.jsonc'),
    });
    assert.equal(biome.reusable, false);
    assert.notEqual(biome.runtime, identity(f.root, env).runtime);
    assert.ok(biome.unknown.includes('BIOME_CONFIG_PATH'));
    assert.equal(identity(f.root, { ...env, BIOME_UNKNOWN_OVERRIDE: 'x' }).reusable, false);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
    rmSync(external, { recursive: true, force: true });
  }
});

test('missing mandatory unit stage fails independent battery assertion', async () => {
  const f = fixture();
  const index = STAGES.findIndex(([, command]) => command === 'test');
  const [removed] = STAGES.splice(index, 1);
  try {
    await f.gate();
    assert.throws(() =>
      assert.deepEqual(
        STAGES.map(([, command]) => command),
        REQUIRED_COMMANDS
      )
    );
    assert.throws(() => assert.deepEqual(f.calls, REQUIRED_COMMANDS));
  } finally {
    STAGES.splice(index, 0, removed);
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('cold pinned archive bootstrap precedes capture and failure cannot consume prior proof', async () => {
  const f = fixture();
  try {
    mkdirSync(join(f.root, 'scripts'));
    mkdirSync(join(f.root, 'node_modules'));
    writeFileSync(join(f.root, '.gitignore'), '.performance/\nnode_modules/\n');
    const archive = join(f.root, 'node_modules/pinned-archive.tar.gz');
    writeFileSync(
      join(f.root, 'scripts/check-actions.sh'),
      `#!/usr/bin/env bash\nset -euo pipefail\nif [[ ! -f node_modules/pinned-archive.tar.gz ]]; then printf 'pinned bytes' > node_modules/pinned-archive.tar.gz; fi\necho canonical-helper-prepared\n`
    );
    f.git('add', '.');
    const capture = () => {
      const result = f.capture();
      assert.equal(readFileSync(archive, 'utf8'), 'pinned bytes');
      return { ...result, installation: digest(readFileSync(archive)) };
    };
    const options = {
      root: f.root,
      capture,
      run: f.run,
      validateReview: f.validateReview,
      environment: process.env,
    };
    const first = await runGate(options);
    assert.deepEqual(f.calls, REQUIRED_COMMANDS);
    assert.match(readFileSync(first.bootstrap.artifact, 'utf8'), /canonical-helper-prepared/u);
    f.calls.length = 0;
    await runGate(options);
    assert.deepEqual(f.calls, []);
    const path = join(f.root, '.performance/gate/receipt.json');
    const prior = readFileSync(path, 'utf8');
    await assert.rejects(
      () =>
        runGate({
          ...options,
          prepare: () => ({ status: 9, stdout: 'bootstrap failed diagnostics' }),
        }),
      /tool preparation failed/u
    );
    assert.deepEqual(f.calls, []);
    assert.equal(readFileSync(path, 'utf8'), prior);
    const preparationHomes = readdirSync(join(f.root, '.performance/gate')).filter((name) =>
      name.startsWith('prepare.')
    );
    assert.ok(
      preparationHomes.some((name) =>
        readFileSync(join(f.root, '.performance/gate', name, 'output.log'), 'utf8').includes(
          'bootstrap failed diagnostics'
        )
      )
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('candidate index parity reads large tracked binary assets without pipe truncation', () => {
  const f = fixture();
  try {
    const path = join(f.root, 'large-music.bin');
    const payload = Buffer.alloc(4 * 1024 * 1024, 0x63);
    writeFileSync(path, payload);
    f.git('add', '.');
    assert.equal(candidateMatches(f.root, sourceRows(f.root)), true);
    payload[payload.length - 1] = 0x64;
    writeFileSync(path, payload);
    assert.equal(candidateMatches(f.root, sourceRows(f.root)), false);
    f.git('add', '.');
    assert.equal(candidateMatches(f.root, sourceRows(f.root)), true);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('Git boundary failures retain bounded exit, signal, error and stderr diagnostics', () => {
  const root = mkdtempSync(join(tmpdir(), 'georoids-git-error-'));
  try {
    assert.throws(
      () => sourceRows(root),
      /git ls-files failed \(exit=128, signal=none, error=none\): fatal: not a git repository/u
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('manual, nested npm and hook launches execute identical runtime inputs without ignoring overrides', (t) => {
  const f = fixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  mkdirSync(join(f.root, 'bin'));
  mkdirSync(join(f.root, 'node_modules'));
  writeFileSync(join(f.root, '.gitignore'), '.performance/\nnode_modules/\nbin/\n');
  writeFileSync(join(f.root, 'package.json'), '{"name":"owned-runtime-fixture","private":true}');
  const gitTool = join(f.root, 'bin/git');
  writeFileSync(gitTool, '#!/bin/sh\nexec /usr/bin/git "$@"\n', { mode: 0o755 });
  const probe = join(f.root, 'probe.mjs');
  writeFileSync(
    probe,
    `
    import {canonicalEnvironment} from ${JSON.stringify(new URL('./gate-runtime.mjs', import.meta.url).href)};
    import {identity} from ${JSON.stringify(new URL('./gate-receipt.mjs', import.meta.url).href)};
    import {verifyChild} from ${JSON.stringify(new URL('./validation-admission.mjs', import.meta.url).href)};
    verifyChild(process.cwd(), 'checkout');
    const env = canonicalEnvironment(process.cwd(), process.env);
    process.env.PATH = env.PATH;
    process.env.FLEET_DOC_FAST = env.FLEET_DOC_FAST;
    for (const key of Object.keys(process.env)) {
      if (!Object.hasOwn(env, key)) delete process.env[key];
    }
    for (const key of ['NODE_REPL_NODE_MODULE_DIRS','NODE_REPL_TRUSTED_CODE_PATHS','NODE_REPL_TRUSTED_SERVICES']) {
      if (Object.hasOwn(process.env, key)) throw new Error('REPL metadata reached validation execution');
    }
    const r=identity(process.cwd(), env);
    console.log(JSON.stringify({runtime:r.runtime, source:r.sourceDigest, installation:r.installation,
      reusable:r.reusable, unknown:r.unknown}));
  `
  );
  const launcher = join(f.root, 'launcher.mjs');
  writeFileSync(
    launcher,
    `
    import {validationLaunch} from ${JSON.stringify(new URL('./gate-runtime.mjs', import.meta.url).href)};
    import {runAdmitted} from ${JSON.stringify(new URL('./validation-admission.mjs', import.meta.url).href)};
    const launch = await validationLaunch(process.cwd(), process.env, ${JSON.stringify(probe)});
    process.exitCode = await runAdmitted('checkout', launch.command, {
      root: process.cwd(), environment: launch.environment,
    });
  `
  );
  const admittedParent = join(f.root, 'admitted-parent.mjs');
  writeFileSync(
    admittedParent,
    `
    import {runAdmitted} from ${JSON.stringify(new URL('./validation-admission.mjs', import.meta.url).href)};
    process.exitCode = await runAdmitted('checkout', [process.execPath, ${JSON.stringify(launcher)}], { root: process.cwd() });
  `
  );
  const base = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !key.startsWith('GIT_') && !key.startsWith('GEOROIDS_') && !key.startsWith('NODE_TEST_')
    )
  );
  Object.assign(base, {
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    NODE_REPL_NODE_MODULE_DIRS: 'fixture-only-modules',
    NODE_REPL_TRUSTED_CODE_PATHS: 'fixture-only-paths',
    NODE_REPL_TRUSTED_SERVICES: 'fixture-only-services',
    PATH: `${join(f.root, 'bin')}:${process.env.PATH}`,
  });
  const core = spawnSync('/usr/bin/git', ['--exec-path'], { encoding: 'utf8' }).stdout.trim();
  function launch(environment, nested = false, admitted = false) {
    const command = nested
      ? lifecycleCommand(f.root, environment, launcher)
      : [process.execPath, admitted ? admittedParent : launcher];
    const result = spawnSync(command[0], command.slice(1), {
      cwd: f.root,
      env: environment,
      encoding: 'utf8',
      timeout: 20000,
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout.slice(result.stdout.indexOf('{')));
  }
  const direct = launch(base);
  assert.equal(direct.reusable, true, JSON.stringify(direct.unknown));
  assert.deepEqual(launch(base, true), direct);
  assert.deepEqual(
    launch(base, false, true),
    direct,
    'an admitted parent retains its authenticated authority'
  );
  assert.deepEqual(
    launch({
      ...base,
      NODE_REPL_NODE_MODULE_DIRS: 'different-modules',
      NODE_REPL_TRUSTED_CODE_PATHS: 'different-paths',
      NODE_REPL_TRUSTED_SERVICES: 'different-services',
    }),
    direct
  );
  assert.deepEqual(launch({ ...base, GIT_PREFIX: '', PATH: `${core}:${base.PATH}` }), direct);
  assert.notEqual(
    launch({ ...base, PATH: `${core}:${base.PATH}` }).runtime,
    direct.runtime,
    'an intentional non-hook Git backend selection remains distinct'
  );
  assert.notEqual(
    launch({ ...base, PATH: `${base.PATH}:${join(f.root, 'extra-path')}` }).runtime,
    direct.runtime
  );
  writeFileSync(gitTool, '#!/bin/sh\n# changed selected tool bytes\nexec /usr/bin/git "$@"\n', {
    mode: 0o755,
  });
  assert.notEqual(launch(base).runtime, direct.runtime);
  writeFileSync(join(f.root, 'node_modules/payload'), 'changed installed bytes');
  assert.notEqual(launch(base).installation, direct.installation);
  const unknown = launch({ ...base, GEOROIDS_UNCLASSIFIED_INPUT: 'enabled' });
  assert.equal(unknown.reusable, false);
  assert(unknown.unknown.includes('GEOROIDS_UNCLASSIFIED_INPUT'));
  const replUnknown = launch({ ...base, NODE_REPL_NEW_OVERRIDE: 'enabled' });
  assert.equal(replUnknown.reusable, false);
  assert(replUnknown.unknown.includes('NODE_REPL_NEW_OVERRIDE'));
  mkdirSync(join(f.root, '.performance'), { recursive: true });
  const config = join(f.root, '.performance/config.npmrc');
  writeFileSync(config, 'loglevel=warn\n');
  const selected = { ...base, npm_config_userconfig: config };
  const before = launch(selected);
  writeFileSync(config, 'loglevel=error\n');
  assert.notEqual(launch(selected).runtime, before.runtime);
  writeFileSync(join(f.root, 'package.json'), '{"scripts":{"env":"echo bypass"}}');
  assert.throws(() => lifecycleCommand(f.root, base, probe), /built-in env/u);
  writeFileSync(join(f.root, 'package.json'), '{"scripts":{"preenv":"echo unexpected"}}');
  assert.throws(() => lifecycleCommand(f.root, base, probe), /built-in env/u);
  assert.throws(
    () => canonicalEnvironment(f.root, { ...base, PATH: join(f.root, 'missing-bin') }),
    /Cannot identify Git hook runtime/u
  );
});

test('stalled npm script-shell setup is owned, cancelled and cleaned without exposing captured environment', async () => {
  for (const fault of ['timeout', 'interruption', 'overflow', 'resistant']) {
    const f = fixture();
    const records = ['shell.json', 'descendant.json'].map((name) => join(f.root, name));
    let driver;
    let completed;
    const live = (record) => {
      const start = spawnSync('ps', ['-p', String(record.pid), '-o', 'lstart='], {
        encoding: 'utf8',
      }).stdout.trim();
      const state = spawnSync('ps', ['-p', String(record.pid), '-o', 'stat='], {
        encoding: 'utf8',
      }).stdout.trim();
      return start === record.start && state && !state.includes('Z');
    };
    try {
      writeFileSync(join(f.root, 'package.json'), '{"private":true}');
      const privateValue = 'fixture-private-environment-value';
      const report = `const fs = require('node:fs');
        const start = require('node:child_process').spawnSync('ps', ['-p', String(process.pid), '-o', 'lstart='], {encoding:'utf8'}).stdout.trim();
        if (process.env.TERM_RESISTANT === '1') process.on('SIGTERM', () => {});
        fs.writeFileSync(process.argv[1], JSON.stringify({pid:process.pid,start}));
        setInterval(() => {}, 1000);`;
      const shell = join(f.root, 'stalled-shell.cjs');
      writeFileSync(
        shell,
        `#!${process.execPath}
        const fs = require('node:fs');
        const cp = require('node:child_process');
        if (process.env.TERM_RESISTANT === '1') process.on('SIGTERM', () => {});
        const start = cp.spawnSync('ps', ['-p', String(process.pid), '-o', 'lstart='], {encoding:'utf8'}).stdout.trim();
        fs.writeFileSync(${JSON.stringify(records[0])}, JSON.stringify({pid:process.pid,start}));
        cp.spawn(process.execPath, ['-e', ${JSON.stringify(report)}, ${JSON.stringify(records[1])}], {stdio:'inherit'});
        process.stdout.write(${JSON.stringify(privateValue)});
        if (${JSON.stringify(fault)} === 'overflow') {
          const timer = setInterval(() => {
            if (fs.existsSync(${JSON.stringify(records[1])})) {
              clearInterval(timer); process.stdout.write(Buffer.alloc(5 * 1024 * 1024, 120));
            }
          }, 10);
        }
        setInterval(() => {}, 1000);
      `,
        { mode: 0o755 }
      );
      const env = Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) =>
            !key.startsWith('GIT_') && !key.startsWith('GEOROIDS_') && !key.startsWith('NODE_TEST_')
        )
      );
      Object.assign(env, {
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        npm_config_script_shell: shell,
      });
      const preload = join(f.root, 'controlled-grace.mjs');
      writeFileSync(
        preload,
        `const schedule = globalThis.setTimeout;
        globalThis.setTimeout = (callback, ms, ...args) => schedule(callback, ms === 45000 ? 100 : ms, ...args);`
      );
      if (fault === 'resistant') {
        env.TERM_RESISTANT = '1';
      }
      driver = spawn(
        process.execPath,
        [
          ...(fault === 'resistant' ? ['--import', preload] : []),
          '--input-type=module',
          '-e',
          `
        import {validationLaunch} from ${JSON.stringify(new URL('./gate-runtime.mjs', import.meta.url).href)};
        try {
          await validationLaunch(process.cwd(), process.env, 'unused-after-setup-failure', {timeoutMs:${fault === 'timeout' ? 1000 : 20000}});
          process.exitCode = 2;
        } catch(error) { console.error(error.message); process.exitCode = 1; }
      `,
        ],
        { cwd: f.root, env, stdio: ['ignore', 'pipe', 'pipe'] }
      );
      let output = '';
      driver.stdout.on('data', (chunk) => {
        output += chunk;
      });
      driver.stderr.on('data', (chunk) => {
        output += chunk;
      });
      completed = new Promise((accept) =>
        driver.once('close', (code, signal) => accept({ code, signal }))
      );
      const deadline = Date.now() + 8000;
      while (!records.every(existsSync)) {
        assert(Date.now() < deadline, 'owned shell and descendant did not start');
        await delay(10);
      }
      const owned = records.map((path) => JSON.parse(readFileSync(path, 'utf8')));
      if (fault === 'interruption' || fault === 'resistant') {
        driver.kill('SIGTERM');
      }
      let watchdog;
      const result = await Promise.race([
        completed,
        new Promise((_, reject) => {
          watchdog = setTimeout(
            () => reject(new Error('owned setup supervisor did not close')),
            8000
          );
        }),
      ]).finally(() => clearTimeout(watchdog));
      assert.equal(result.code, 1, output);
      assert.equal(result.signal, null);
      if (fault === 'resistant') {
        assert.match(output, /Validation cleanup is unproven/u);
        assert.match(output, /Preserved checkout ownership/u);
        assert.equal(output.includes(privateValue), false);
        for (const record of owned) {
          assert.equal(Boolean(live(record)), true);
        }
        assert.equal(existsSync(join(f.root, '.git/georoids-validation-checkout.lock')), true);
        const retry = spawnSync(
          process.execPath,
          [
            '--input-type=module',
            '-e',
            `
          import {validationLaunch} from ${JSON.stringify(new URL('./gate-runtime.mjs', import.meta.url).href)};
          try { await validationLaunch(process.cwd(), process.env, 'never-issued'); }
          catch(error) { console.error(error.message); process.exitCode = 1; }
        `,
          ],
          { cwd: f.root, env, encoding: 'utf8', timeout: 5000 }
        );
        assert.equal(retry.status, 1);
        assert.match(retry.stderr, /Checkout validation already owned/u);
        continue;
      }
      assert.match(
        output,
        new RegExp(`exit=${fault === 'timeout' ? 124 : fault === 'interruption' ? 143 : 1}`, 'u')
      );
      assert.equal(
        output.includes(privateValue),
        false,
        'captured environment never reaches diagnostics'
      );
      for (const record of owned) {
        assert.equal(Boolean(live(record)), false, 'owned setup descendants are stopped');
      }
      assert.equal(existsSync(join(f.root, '.git/georoids-validation-checkout.lock')), false);
    } finally {
      // Only fixture processes whose recorded birth still matches may be stopped.
      const lock = join(f.root, '.git/georoids-validation-checkout.lock/children');
      if (existsSync(lock)) {
        for (const name of readdirSync(lock)) {
          const command = JSON.parse(readFileSync(join(lock, name), 'utf8')).command;
          if (command && live(command)) {
            process.kill(command.pid, 'SIGKILL');
          }
        }
      }
      for (const path of records.filter(existsSync)) {
        const record = JSON.parse(readFileSync(path, 'utf8'));
        if (live(record)) {
          process.kill(record.pid, 'SIGKILL');
        }
      }
      if (driver && driver.exitCode === null && driver.signalCode === null) {
        driver.kill('SIGTERM');
      }
      if (completed) {
        await completed;
      }
      rmSync(f.root, { recursive: true, force: true });
    }
  }
});
