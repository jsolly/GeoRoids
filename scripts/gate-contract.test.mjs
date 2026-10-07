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
import { fileURLToPath } from 'node:url';
import { runGate } from './gate.mjs';
import { candidateMatches, digest, fileRecord, STAGES, sourceRows } from './gate-receipt.mjs';
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
  const capture = () => {
    const source = sourceRows(root);
    return {
      source,
      sourceDigest: digest(JSON.stringify(source)),
      installation,
      runtime,
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
    mkdirSync(join(f.root, 'browsers'));
    for (const name of ['npm', 'bash', 'git', 'uvx']) {
      writeFileSync(join(f.root, 'bin', name), name, { mode: 0o755 });
    }
    writeFileSync(
      join(f.root, 'bin', 'npm'),
      `console.log('userconfig='+(process.env.npm_config_userconfig || process.env.HOME+'/.npmrc')); console.log('globalconfig='+(process.env.npm_config_globalconfig || process.env.HOME+'/etc/npmrc'));`,
      { mode: 0o755 }
    );
    writeFileSync(
      join(f.root, '.gitignore'),
      '.performance/\nnode_modules/\nbin/\nbrowsers/\n.env.local\n'
    );
    const payload = join(f.root, 'node_modules', 'native.node');
    writeFileSync(payload, 'native payload');
    writeFileSync(join(f.root, '.env.local'), 'SECRET=one');
    const env = {
      PATH: join(f.root, 'bin'),
      HOME: fixtureHome,
      PLAYWRIGHT_BROWSERS_PATH: join(f.root, 'browsers'),
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
    assert.match(
      readFileSync(new URL('./test-runner.sh', import.meta.url), 'utf8'),
      /export GEOROIDS_TEST_SESSION_DIR="\$SHARD_DIRECTORY"/u
    );
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
    for (const name of ['bin', 'node_modules', 'browsers', 'home', 'home/etc']) {
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
      '.performance/\nnode_modules/\nbin/\nbrowsers/\nhome/\n.env.local\n'
    );
    const env = {
      PATH: join(f.root, 'bin'),
      HOME: join(f.root, 'home'),
      PLAYWRIGHT_BROWSERS_PATH: join(f.root, 'browsers'),
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
    assert.notEqual(committed.runtime, first.runtime);
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
    assert.notEqual(identity(f.root, env).runtime, committed.runtime);
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
    symlinkSync(external, join(f.root, 'home/browser-root-link'));
    assert.throws(
      () =>
        identity(f.root, {
          ...env,
          PLAYWRIGHT_BROWSERS_PATH: join(f.root, 'home/browser-root-link'),
        }),
      /Unsupported installed inventory root link/u
    );
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
