import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const helper = fileURLToPath(new URL('./validation-admission.mjs', import.meta.url));
const childScript = `
const fs = require('node:fs');
const [started, release, proof] = process.argv.slice(1);
const start = require('node:child_process').spawnSync('ps', ['-p', String(process.pid), '-o', 'lstart='], {encoding:'utf8'}).stdout.trim();
function finish() {
  if (process.env.GEOROIDS_TEST_RUNNER_RECEIPT && proof !== 'missing') {
    fs.writeFileSync(process.env.GEOROIDS_TEST_RUNNER_RECEIPT, JSON.stringify({
      kind:'georoids-runner-final', worktree:fs.realpathSync(process.cwd()),
      ownerPid:process.pid, cleanupSucceeded:proof !== 'failed',
      lockReleased:true, sessionRemoved:true
    }));
  }
  fs.writeFileSync(started + '.ended', String(Date.now()));
  process.exit(proof === 'test-failed' ? 1 : 0);
}
let cleaning = false;
function cancel() {
  if (cleaning) {
    if (proof === 'first-forward') fs.writeFileSync(started + '.forwarded', '');
    return;
  }
  cleaning = true;
  if (proof === 'held-cleanup') { fs.writeFileSync(started + '.cleaning', ''); return; }
  if (proof === 'repeat-cleanup' || proof === 'first-forward') {
    const cleanup = require('node:child_process').spawn(process.execPath, ['-e',
      "const fs = require('node:fs'); fs.writeFileSync(process.argv[1], ''); if (process.argv[2] === 'first-forward') { setInterval(() => { if (fs.existsSync(process.argv[1] + '-release')) process.exit(0); }, 10); } else setTimeout(() => process.exit(0), 400)",
      started + '.cleanup', proof
    ], {stdio:'inherit'});
    cleanup.once('exit', (code, signal) => {
      fs.writeFileSync(started + '.cleanup-result', JSON.stringify({code, signal}));
      code === 0 && !signal ? finish() : process.exit(2);
    });
  } else {
    setTimeout(finish, 250);
  }
}
process.on('SIGTERM', cancel);
process.on('SIGINT', cancel);
// Observe HUP in this fixture so it can retain the descendant's actual signal.
// The real runner supports graceful cleanup only for INT/TERM.
process.on('SIGHUP', cancel);
fs.writeFileSync(started, JSON.stringify({pid:process.pid, start, at:Date.now(), root:process.cwd(), env:Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('GEOROIDS_VALIDATION_')))}));
setInterval(() => { if(fs.existsSync(release)) finish(); }, 20);
`;
async function until(predicate, description) {
  const deadline = Date.now() + 10000;
  while (!predicate()) {
    assert(Date.now() < deadline, `Timed out waiting for ${description}`);
    await delay(25);
  }
}
function fixture(t) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'georoids-admission-')));
  const root = join(directory, 'primary');
  mkdirSync(root);
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.startsWith('GIT_') && !key.startsWith('GEOROIDS_')
    )
  );
  Object.assign(env, { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' });
  function git(cwd, ...args) {
    const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
      cwd,
      env,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  }
  git(root, 'init', '-q');
  git(
    root,
    '-c',
    'user.name=Contract',
    '-c',
    'user.email=contract@example.invalid',
    'commit',
    '--allow-empty',
    '-qm',
    'fixture'
  );
  const common = join(root, '.git');
  const wrappers = [];
  const workers = [];
  t.after(async () => {
    for (const worker of workers) {
      if (existsSync(worker)) {
        const owned = JSON.parse(readFileSync(worker, 'utf8'));
        const current = spawnSync('ps', ['-p', String(owned.pid), '-o', 'lstart='], {
          encoding: 'utf8',
        });
        if (current.status === 0 && current.stdout.trim() === owned.start) {
          try {
            process.kill(owned.pid, 'SIGKILL');
          } catch (error) {
            if (error.code !== 'ESRCH') {
              throw error;
            }
          }
        }
      }
    }
    for (const wrapper of wrappers) {
      if (wrapper.exitCode === null && wrapper.signalCode === null) {
        wrapper.kill('SIGKILL');
      }
    }
    await Promise.all(wrappers.map((wrapper) => wrapper.completed));
    rmSync(directory, { recursive: true, force: true });
  });
  function sibling(name) {
    const path = join(directory, name);
    git(root, 'worktree', 'add', '-qb', name, path);
    return path;
  }
  function start(
    name,
    {
      cwd = root,
      kind = 'frame',
      proof = 'clean',
      environment = {},
      command,
      preload,
      timeoutMs,
    } = {}
  ) {
    const started = join(directory, `${name}.started`);
    const release = join(directory, `${name}.release`);
    workers.push(started);
    const child = spawn(
      process.execPath,
      [
        ...(preload ? ['--import', preload] : []),
        ...(timeoutMs === undefined
          ? [
              helper,
              kind,
              '--',
              ...(command || [process.execPath, '-e', childScript, started, release, proof]),
            ]
          : [
              '--input-type=module',
              '-e',
              `const {runAdmitted} = await import(${JSON.stringify(helper)}); process.exitCode = await runAdmitted(${JSON.stringify(kind)}, ${JSON.stringify(command || [process.execPath, '-e', childScript, started, release, proof])}, {timeoutMs:${JSON.stringify(timeoutMs)}});`,
            ]),
      ],
      { cwd, env: { ...env, ...environment }, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    child.output = '';
    child.stdout.on('data', (data) => {
      child.output += data;
    });
    child.stderr.on('data', (data) => {
      child.output += data;
    });
    child.exited = new Promise((accept) =>
      child.once('exit', (code, signal) => accept({ code, signal }))
    );
    child.completed = new Promise((accept) =>
      child.once('close', (code, signal) => accept({ code, signal }))
    );
    wrappers.push(child);
    return { child, started, release, finish: () => writeFileSync(release, '') };
  }
  const queue = () =>
    existsSync(join(common, 'georoids-validation-queue'))
      ? readdirSync(join(common, 'georoids-validation-queue'))
      : [];
  return { directory, root, common, env, start, sibling, queue, git };
}

for (const failure of ['existing receipt', 'missing executable']) {
  test(`${failure} before command startup releases only its own validation ownership`, async (t) => {
    const f = fixture(t);
    const siblingRoot = f.sibling('live-sibling');
    const sibling = f.start('sibling', { cwd: siblingRoot, kind: 'integration' });
    await until(() => existsSync(sibling.started), 'unrelated live sibling');
    const siblingLock = join(
      f.common,
      'worktrees',
      'live-sibling',
      'georoids-validation-checkout.lock'
    );
    const siblingOwner = readFileSync(join(siblingLock, 'owner.json'), 'utf8');
    const receipt = join(f.directory, 'existing-receipt.json');
    writeFileSync(receipt, 'original receipt evidence\n');
    const rejected = f.start('rejected', {
      kind: 'runner',
      ...(failure === 'existing receipt'
        ? { environment: { GEOROIDS_TEST_RUNNER_RECEIPT: receipt } }
        : { command: [join(f.directory, 'no-such-executable')] }),
    });
    assert.deepEqual(await rejected.child.completed, { code: 1, signal: null });
    assert.match(
      rejected.child.output,
      failure === 'existing receipt' ? /Runner cleanup receipt already exists/u : /ENOENT/u
    );
    assert(!existsSync(rejected.started), 'rejected command never executed');
    assert.equal(readFileSync(receipt, 'utf8'), 'original receipt evidence\n');
    assert(
      !existsSync(join(f.common, 'georoids-validation-checkout.lock')),
      'no issued command needs the failed checkout barrier'
    );
    assert.deepEqual(f.queue(), [], 'only the failed attempt owned a heavy ticket');
    assert.equal(readFileSync(join(siblingLock, 'owner.json'), 'utf8'), siblingOwner);
    assert.equal(sibling.child.exitCode, null, 'unrelated sibling remains live');
    const next = f.start('next', { kind: 'runner' });
    await until(() => existsSync(next.started), 'next admitted command');
    next.finish();
    assert.deepEqual(await next.child.completed, { code: 0, signal: null });
    sibling.finish();
    assert.deepEqual(await sibling.child.completed, { code: 0, signal: null });
  });
}

test('a parent records a nested command startup failure without requiring nonexistent process cleanup', async (t) => {
  const f = fixture(t);
  const evidence = join(f.directory, 'nested-setup.json');
  const command = [
    process.execPath,
    '-e',
    `
    const fs = require('node:fs');
    const result = require('node:child_process').spawnSync(process.execPath,
      ${JSON.stringify([helper, 'runner', '--', join(f.directory, 'missing-nested-command')])},
      {env:process.env, encoding:'utf8'});
    const records = fs.readdirSync(${JSON.stringify(join(f.common, 'georoids-validation-checkout.lock', 'children'))})
      .map(name => JSON.parse(fs.readFileSync(${JSON.stringify(join(f.common, 'georoids-validation-checkout.lock', 'children'))} + '/' + name, 'utf8')));
    fs.writeFileSync(${JSON.stringify(evidence)}, JSON.stringify({status:result.status, stderr:result.stderr,
      failed:records.find(record => record.kind === 'runner')}));
    process.exit(result.status);
  `,
  ];
  const parent = f.start('parent', { kind: 'review', command });
  assert.deepEqual(await parent.child.completed, { code: 1, signal: null });
  const failure = JSON.parse(readFileSync(evidence, 'utf8'));
  assert.equal(failure.status, 1);
  assert.match(failure.stderr, /ENOENT/u);
  assert.equal(failure.failed.finished, true);
  assert.equal(failure.failed.cleanupSucceeded, true);
  assert.equal(failure.failed.failure.kind, 'command-not-started');
  assert.match(failure.failed.failure.message, /ENOENT/u);
  assert(!existsSync(join(f.common, 'georoids-validation-checkout.lock')));
  assert.deepEqual(f.queue(), []);
});

for (const fault of ['birth inspection', 'command publication']) {
  test(`an issued child retains both barriers when immediate ${fault} fails`, async (t) => {
    const f = fixture(t);
    const siblingRoot = f.sibling('unrelated');
    const sibling = f.start('sibling', { cwd: siblingRoot, kind: 'integration' });
    await until(() => existsSync(sibling.started), 'unrelated sibling');
    const siblingLock = join(
      f.common,
      'worktrees',
      'unrelated',
      'georoids-validation-checkout.lock'
    );
    const siblingOwner = readFileSync(join(siblingLock, 'owner.json'), 'utf8');
    const preload = join(f.directory, 'issued-fault.mjs');
    writeFileSync(
      preload,
      `
      import cp from 'node:child_process';
      import fs from 'node:fs';
      import {syncBuiltinESMExports} from 'node:module';
      const spawn = cp.spawn;
      const spawnSync = cp.spawnSync;
      const renameSync = fs.renameSync;
      let issuedPid;
      cp.spawn = (...args) => {
        const child = spawn(...args);
        issuedPid = child.pid;
        return child;
      };
      cp.spawnSync = (file, args, options) => {
        if (${JSON.stringify(fault)} === 'birth inspection' && file === 'ps' &&
            args[0] === '-p' && Number(args[1]) === issuedPid) {
          return {status:2, signal:null, stdout:'', stderr:'fixture child birth inspection failed'};
        }
        return spawnSync(file, args, options);
      };
      fs.renameSync = (from, to) => {
        if (${JSON.stringify(fault)} === 'command publication' &&
            String(to).includes('/children/') && JSON.parse(fs.readFileSync(from, 'utf8')).command) {
          throw new Error('fixture command publication failed');
        }
        return renameSync(from, to);
      };
      syncBuiltinESMExports();
    `
    );
    const first = f.start('issued', { kind: 'frame', preload });
    await until(() => existsSync(first.started), 'actually issued child');
    await until(() => first.child.exitCode !== null, 'failed supervisor exit');
    assert.equal(first.child.exitCode, 1, first.child.output);
    assert.match(
      first.child.output,
      fault === 'birth inspection'
        ? /fixture child birth inspection failed/u
        : /fixture command publication failed/u
    );
    assert.match(first.child.output, /Validation cleanup is unproven/u);
    const owned = JSON.parse(readFileSync(first.started, 'utf8'));
    const current = spawnSync('ps', ['-p', String(owned.pid), '-o', 'lstart='], {
      encoding: 'utf8',
    });
    assert.equal(current.status, 0);
    assert.equal(
      current.stdout.trim(),
      owned.start,
      'issued child still lives with its original birth'
    );
    assert(existsSync(join(f.common, 'georoids-validation-checkout.lock')));
    assert.equal(f.queue().length, 1);
    assert.equal(readFileSync(join(siblingLock, 'owner.json'), 'utf8'), siblingOwner);
    assert.equal(sibling.child.exitCode, null);
    first.finish();
    assert.deepEqual(await first.child.completed, { code: 1, signal: null });
    sibling.finish();
    assert.deepEqual(await sibling.child.completed, { code: 0, signal: null });
  });
}

test('linked checkouts enter heavy validation in ticket order and cancelled waiters leave the queue', async (t) => {
  const f = fixture(t);
  const a = f.start('a', { kind: 'frame' });
  await until(() => existsSync(a.started), 'first admitted contract child');
  const b = f.start('b', { cwd: f.sibling('b'), kind: 'frame' });
  await until(() => b.child.output.includes('Waiting for heavy'), 'second ticket');
  const c = f.start('c', { cwd: f.sibling('c') });
  await until(() => c.child.output.includes('Waiting for heavy'), 'third ticket');
  assert.equal(f.queue().length, 3);
  b.child.kill('SIGTERM');
  assert.notEqual((await b.child.completed).code, 0);
  assert.equal(existsSync(b.started), false);
  assert.equal(f.queue().length, 2);
  a.finish();
  assert.equal((await a.child.completed).code, 0, a.child.output);
  await until(() => existsSync(c.started), 'third ticket after cancelled second');
  c.finish();
  assert.equal((await c.child.completed).code, 0, c.child.output);
  assert.deepEqual(f.queue(), []);
});

for (const kind of ['unit', 'contracts', 'integration', 'review']) {
  test(`${kind} code checks in linked checkouts overlap an admitted manual workload`, async (t) => {
    const f = fixture(t);
    const manual = f.start('manual');
    await until(() => existsSync(manual.started), 'active manual workload');
    const code = f.start('code', { cwd: f.sibling('code'), kind });
    await until(() => existsSync(code.started), 'code validation starts independently');
    assert.equal(manual.child.exitCode, null);
    assert.equal(f.queue().length, 1);
    code.finish();
    assert.equal((await code.child.completed).code, 0, code.child.output);
    assert.equal(f.queue().length, 1);
    manual.finish();
    assert.equal((await manual.child.completed).code, 0, manual.child.output);
    assert.deepEqual(f.queue(), []);
  });
}

test('same checkout gate and standalone measurements refuse overlap before either can change artifacts', async (t) => {
  const f = fixture(t);
  const first = f.start('gate', { kind: 'checkout' });
  await until(() => existsSync(first.started), 'gate child');
  const second = f.start('frame', { kind: 'frame' });
  assert.notEqual((await second.child.completed).code, 0);
  assert.match(second.child.output, /Checkout validation already owned/u);
  assert.equal(existsSync(second.started), false);
  first.finish();
  assert.equal((await first.child.completed).code, 0, first.child.output);
});

test('authenticated descendants share checkout and admission without acquiring another ticket', async (t) => {
  const f = fixture(t);
  const nestedStarted = join(f.directory, 'nested.started');
  const nestedRelease = join(f.directory, 'nested.release');
  writeFileSync(nestedRelease, '');
  const command = [
    process.execPath,
    helper,
    'runner',
    '--',
    process.execPath,
    '-e',
    childScript,
    nestedStarted,
    nestedRelease,
    'clean',
  ];
  const parent = f.start('parent', { command });
  assert.equal((await parent.child.completed).code, 0, parent.child.output);
  assert(existsSync(nestedStarted));
  assert.equal((parent.child.output.match(/Heavy validation admitted/gu) || []).length, 1);
  assert.deepEqual(f.queue(), []);
});

test('a copied live token cannot authorize an unrelated process or a PID with a changed birth', async (t) => {
  const f = fixture(t);
  const first = f.start('owner');
  await until(() => existsSync(first.started), 'owner child');
  const captured = JSON.parse(readFileSync(first.started, 'utf8')).env;
  const environment = Object.fromEntries(
    Object.entries(captured).filter(([key]) => key.startsWith('GEOROIDS_VALIDATION_'))
  );
  const forged = f.start('forged', { environment });
  assert.notEqual((await forged.child.completed).code, 0);
  assert.match(forged.child.output, /not a live ancestor/u);
  assert.equal(existsSync(forged.started), false);
  const ownerPath = join(f.common, 'georoids-validation-checkout.lock', 'owner.json');
  const owner = JSON.parse(readFileSync(ownerPath, 'utf8'));
  writeFileSync(ownerPath, JSON.stringify({ ...owner, start: 'stale birth' }));
  const stale = f.start('stale', { environment });
  assert.notEqual((await stale.child.completed).code, 0);
  assert.match(stale.child.output, /dead or its PID was reused/u);
  writeFileSync(ownerPath, JSON.stringify(owner));
  first.finish();
  assert.equal((await first.child.completed).code, 0, first.child.output);
});

for (const proof of ['missing', 'failed']) {
  test(`a runner with ${proof} cleanup evidence retains both admission and checkout ownership`, async (t) => {
    const f = fixture(t);
    const runner = f.start('runner', { kind: 'runner', proof });
    await until(() => existsSync(runner.started), 'runner child');
    runner.finish();
    assert.notEqual((await runner.child.completed).code, 0);
    assert.equal(f.queue().length, 1);
    assert(existsSync(join(f.common, 'georoids-validation-checkout.lock')));
    const next = f.start('next', { cwd: f.sibling('next') });
    assert.notEqual((await next.child.completed).code, 0);
    assert.match(next.child.output, /Dead validation owner requires cleanup verification/u);
    assert.equal(existsSync(next.started), false);
  });
}

test('a failed assertion releases capacity when the runner proves owned cleanup', async (t) => {
  const f = fixture(t);
  const runner = f.start('runner', { kind: 'runner', proof: 'test-failed' });
  await until(() => existsSync(runner.started), 'runner child');
  runner.finish();
  assert.equal((await runner.child.completed).code, 1);
  assert.deepEqual(f.queue(), []);
  assert.equal(existsSync(join(f.common, 'georoids-validation-checkout.lock')), false);
});

test('repeated cancellation leaves runner cleanup helpers alive until their receipt is written', async (t) => {
  const f = fixture(t);
  const runner = f.start('runner', { kind: 'runner', proof: 'repeat-cleanup' });
  await until(() => existsSync(runner.started), 'runner child');
  runner.child.kill('SIGTERM');
  await until(() => existsSync(`${runner.started}.cleanup`), 'runner cleanup helper');
  runner.child.kill('SIGTERM');
  runner.child.kill('SIGINT');
  assert.equal((await runner.child.completed).code, 143, runner.child.output);
  assert.deepEqual(f.queue(), []);
  assert.equal(existsSync(join(f.common, 'georoids-validation-checkout.lock')), false);
});

for (const [kind, signal, title] of [
  [
    'runner',
    'SIGTERM',
    'the first supervisor cancellation preserves cleanup already started by its runner',
  ],
  ['review', 'SIGTERM', 'cancelling a generic command still signals its live descendants'],
  ['runner', 'SIGHUP', 'runner HUP reaches descendants and retains failed cleanup evidence'],
]) {
  test(title, async (t) => {
    const f = fixture(t);
    const runner = f.start('runner', { kind, proof: 'first-forward' });
    try {
      await until(() => existsSync(runner.started), 'runner child');
      const owned = JSON.parse(readFileSync(runner.started, 'utf8'));
      const current = spawnSync('ps', ['-p', String(owned.pid), '-o', 'ppid=,lstart='], {
        encoding: 'utf8',
      });
      assert.equal(current.status, 0, current.stderr);
      const identity = current.stdout.trim().match(/^(\d+)\s+(.+)$/u);
      assert.equal(Number(identity?.[1]), runner.child.pid);
      assert.equal(identity?.[2], owned.start);
      process.kill(owned.pid, 'SIGTERM');
      await until(() => existsSync(`${runner.started}.cleanup`), 'already running cleanup helper');
      runner.child.kill(signal);
      await until(
        () => existsSync(`${runner.started}.forwarded`),
        'first supervisor signal delivered'
      );
      writeFileSync(`${runner.started}.cleanup-release`, '');
      const failedCleanup = signal === 'SIGHUP';
      assert.equal(
        (await runner.child.completed).code,
        failedCleanup ? 2 : 143,
        runner.child.output
      );
      assert.deepEqual(
        JSON.parse(readFileSync(`${runner.started}.cleanup-result`, 'utf8')),
        kind === 'runner' && !failedCleanup ? { code: 0, signal: null } : { code: null, signal }
      );
      assert.equal(f.queue().length, failedCleanup ? 1 : 0);
      assert.equal(existsSync(join(f.common, 'georoids-validation-checkout.lock')), failedCleanup);
    } finally {
      writeFileSync(`${runner.started}.cleanup-release`, '');
    }
  });
}

test('unexpected wrapper death cannot hand capacity to a sibling even after its command stops', async (t) => {
  const f = fixture(t);
  const first = f.start('owner');
  await until(() => existsSync(first.started), 'owner child');
  first.child.kill('SIGKILL');
  await first.child.exited;
  const next = f.start('next', { cwd: f.sibling('next') });
  assert.notEqual((await next.child.completed).code, 0);
  assert.match(next.child.output, /Dead validation owner requires cleanup verification/u);
  assert.equal(existsSync(next.started), false);
  first.finish();
});

test('an unexpected command signal retains admission even when the process group is empty', async (t) => {
  const f = fixture(t);
  const first = f.start('owner');
  await until(() => existsSync(first.started), 'owner child');
  process.kill(JSON.parse(readFileSync(first.started, 'utf8')).pid, 'SIGKILL');
  assert.notEqual((await first.child.completed).code, 0);
  assert.match(first.child.output, /died unexpectedly/u);
  assert.equal(f.queue().length, 1);
});

test('unresolved legacy runner cleanup blocks the new queue without deleting its evidence', async (t) => {
  const f = fixture(t);
  const lock = join(f.common, 'georoids-test-runner.lock');
  mkdirSync(lock);
  const dead = spawnSync(process.execPath, ['-e', ''], { env: f.env });
  writeFileSync(join(lock, 'pid'), `${dead.pid}\n`);
  writeFileSync(join(lock, 'cleanup-failed.json'), '{}');
  const first = f.start('blocked');
  assert.notEqual((await first.child.completed).code, 0);
  assert.match(first.child.output, /Unresolved runner cleanup/u);
  assert(existsSync(join(lock, 'cleanup-failed.json')));
  assert.equal(existsSync(first.started), false);
});

test('failed process inspection never authorizes work or clears ownership', async (t) => {
  const f = fixture(t);
  const bin = join(f.directory, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'ps'), '#!/bin/sh\necho inspection-unavailable >&2\nexit 2\n', {
    mode: 0o755,
  });
  const first = f.start('inspection', { environment: { PATH: `${bin}:${f.env.PATH}` } });
  assert.notEqual((await first.child.completed).code, 0);
  assert.match(first.child.output, /Cannot inspect validation PID/u);
  assert.equal(existsSync(first.started), false);
});

function failingInspection(f) {
  const bin = join(f.directory, 'bin');
  const fail = join(f.directory, 'inspection-fails');
  mkdirSync(bin);
  writeFileSync(
    join(bin, 'ps'),
    `#!${process.execPath}
const args = process.argv.slice(2);
if (require('node:fs').existsSync(${JSON.stringify(fail)}) &&
    (args[0] === '-axo' || args[0] === '-g')) {
  process.stderr.write('inspection-unavailable\\n');
  process.exit(2);
}
const result = require('node:child_process').spawnSync('/bin/ps', args, {stdio:'inherit'});
process.exit(result.status ?? 1);
`,
    { mode: 0o755 }
  );
  return { environment: { PATH: `${bin}:${f.env.PATH}` }, fail: () => writeFileSync(fail, '') };
}

test('failed group inspection after the command exits preserves both ownership barriers', async (t) => {
  const f = fixture(t);
  const mock = failingInspection(f);
  const runner = f.start('runner', { environment: mock.environment });
  await until(() => existsSync(runner.started), 'runner child');
  mock.fail();
  runner.finish();
  await until(() => runner.child.exitCode !== null, 'failed cleanup verification exit');
  assert.equal((await runner.child.completed).code, 1, runner.child.output);
  assert.match(runner.child.output, /Cannot inspect validation process group/u);
  const checkout = join(f.common, 'georoids-validation-checkout.lock');
  const queue = join(f.common, 'georoids-validation-queue', f.queue()[0]);
  assert(runner.child.output.includes(checkout));
  assert(runner.child.output.includes(queue));
  assert(existsSync(join(checkout, 'owner.json')));
  assert(existsSync(join(queue, 'active')));
});

test('each earlier live waiter enters before later arrivals', async (t) => {
  const f = fixture(t);
  const first = f.start('first');
  await until(() => existsSync(first.started), 'first owner');
  const second = f.start('second', { cwd: f.sibling('second') });
  await until(() => second.child.output.includes('Waiting for heavy'), 'second ticket');
  const third = f.start('third', { cwd: f.sibling('third') });
  await until(() => third.child.output.includes('Waiting for heavy'), 'third ticket');
  first.finish();
  assert.equal((await first.child.completed).code, 0, first.child.output);
  await until(() => existsSync(second.started), 'second owner');
  assert.equal(existsSync(third.started), false);
  second.finish();
  assert.equal((await second.child.completed).code, 0, second.child.output);
  await until(() => existsSync(third.started), 'third owner');
  third.finish();
  assert.equal((await third.child.completed).code, 0, third.child.output);
});

test('receipt identity removes verified control tokens and preserves unknown gameplay inputs', async (t) => {
  const f = fixture(t);
  const command = [
    process.execPath,
    '--input-type=module',
    '-e',
    `
    import { receiptEnvironment } from ${JSON.stringify(new URL('./validation-admission.mjs', import.meta.url).href)};
    const env = receiptEnvironment(process.cwd(), process.env);
    if (Object.keys(env).some(key => key.startsWith('GEOROIDS_VALIDATION_'))) process.exit(7);
    if (env.GEOROIDS_UNRECOGNIZED_RULE !== 'still-visible') process.exit(8);
  `,
  ];
  const first = f.start('identity', {
    command,
    environment: { GEOROIDS_UNRECOGNIZED_RULE: 'still-visible' },
  });
  assert.equal((await first.child.completed).code, 0, first.child.output);
  const forged = f.start('forged', { environment: { GEOROIDS_VALIDATION_CHILD: '{}' } });
  assert.notEqual((await forged.child.completed).code, 0);
  assert.match(forged.child.output, /Incomplete validation ownership tokens/u);
});

test('a review cannot release admission by ignoring a nested runner cleanup failure', async (t) => {
  const f = fixture(t);
  const started = join(f.directory, 'nested-failed.started');
  const release = join(f.directory, 'nested-failed.release');
  writeFileSync(release, '');
  const command = [
    process.execPath,
    '-e',
    `
    require('node:child_process').spawnSync(process.execPath,
      ${JSON.stringify([helper, 'runner', '--', process.execPath, '-e', childScript, started, release, 'failed'])},
      {env:process.env, stdio:'inherit'});
  `,
  ];
  const parent = f.start('parent', { command });
  assert.notEqual((await parent.child.completed).code, 0);
  assert.match(parent.child.output, /Nested validation cleanup is unproven/u);
  assert.equal(f.queue().length, 1);
});

test('inherited Git redirection cannot move ownership into another repository', async (t) => {
  const f = fixture(t);
  const foreign = join(f.directory, 'foreign');
  mkdirSync(foreign);
  f.git(foreign, 'init', '-q');
  const environment = {
    GIT_DIR: join(foreign, '.git'),
    GIT_COMMON_DIR: join(foreign, '.git'),
    GIT_WORK_TREE: foreign,
    GIT_INDEX_FILE: join(foreign, 'index'),
  };
  const runner = f.start('actual', { environment });
  await until(() => existsSync(runner.started), 'actual checkout child');
  assert.equal(f.queue().length, 1);
  assert(existsSync(join(f.common, 'georoids-validation-checkout.lock')));
  assert.equal(existsSync(join(foreign, '.git', 'georoids-validation-checkout.lock')), false);
  assert.equal(existsSync(join(foreign, '.git', 'georoids-validation-queue')), false);
  runner.finish();
  assert.equal((await runner.child.completed).code, 0, runner.child.output);
});

// Pause real filesystem publication in a native supervisor. Production code has
// no test switches; all Git state and process ownership belongs to this fixture.
function pausePublication(f, phase = 'ticket') {
  const ready = join(f.directory, `${phase}.ready`);
  const release = join(f.directory, `${phase}.resume`);
  const preload = join(f.directory, `${phase}.mjs`);
  const queue = join(f.common, 'georoids-validation-queue');
  const allocation = join(f.common, 'georoids-validation-allocation.lock');
  writeFileSync(
    preload,
    `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const mkdir = fs.mkdirSync;
const rename = fs.renameSync;
let paused = false;
function pause() {
  if (paused) return;
  paused = true;
  fs.writeFileSync(${JSON.stringify(ready)}, '');
  const deadline = Date.now() + 10000;
  while (!fs.existsSync(${JSON.stringify(release)})) {
    if (Date.now() > deadline) throw new Error('Publication fixture timed out');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
}
fs.mkdirSync = function(path, ...args) {
  if (${JSON.stringify(phase)} === 'ticket' &&
      String(path) === ${JSON.stringify(join(queue, '000000000001'))}) pause();
  return mkdir.call(this, path, ...args);
};
fs.renameSync = function(from, to) {
  if (${JSON.stringify(phase)} === 'allocation-owner' &&
      String(to) === ${JSON.stringify(join(allocation, 'owner.json'))}) pause();
  if (${JSON.stringify(phase)} === 'ticket-owner' &&
      String(to) === ${JSON.stringify(join(queue, '000000000001', 'owner.json'))}) pause();
  return rename.call(this, from, to);
};
syncBuiltinESMExports();
`
  );
  return { preload, ready, resume: () => writeFileSync(release, '') };
}
function assertReleased(f, runs) {
  assert.deepEqual(f.queue(), []);
  assert.equal(existsSync(join(f.common, 'georoids-validation-allocation.lock')), false);
  for (const run of runs) {
    if (!existsSync(run.started)) {
      continue;
    }
    const owned = JSON.parse(readFileSync(run.started, 'utf8'));
    const groups = spawnSync('ps', ['-axo', 'pgid=,stat='], { encoding: 'utf8' });
    assert.equal(groups.status, 0, groups.stderr);
    assert.equal(
      groups.stdout.split('\n').some((line) => {
        const [group, state] = line.trim().split(/\s+/u);
        return Number(group) === owned.pid && !state.includes('Z');
      }),
      false,
      `Command group ${owned.pid} remains`
    );
    const gitDir = f.git(owned.root, 'rev-parse', '--absolute-git-dir');
    assert.equal(existsSync(join(gitDir, 'georoids-validation-checkout.lock')), false);
  }
}

test('a delayed ticket publisher cannot reuse a released lower ticket beside an active sibling', async (t) => {
  const f = fixture(t);
  const pause = pausePublication(f);
  const a = f.start('a', { kind: 'runner', preload: pause.preload });
  await until(() => existsSync(pause.ready), 'A selected ticket one before publication');
  const b = f.start('b', { kind: 'runner', cwd: f.sibling('b') });
  await until(
    () => existsSync(b.started) || b.child.output.includes('ticket allocation'),
    'B allocation result'
  );
  const c = f.start('c', { kind: 'runner', cwd: f.sibling('c') });
  await until(() => c.child.output.includes('Waiting for heavy'), 'C waiting');
  if (existsSync(b.started)) {
    // Original code admits B as ticket one and queues C as ticket two. Let C
    // enter after B leaves, then resume A's stale choice of ticket one.
    b.finish();
    assert.equal((await b.child.completed).code, 0, b.child.output);
    await until(() => existsSync(c.started), 'C admitted after B');
    pause.resume();
    await until(() => existsSync(a.started), 'delayed A admitted');
    a.finish();
    c.finish();
  } else {
    assert.deepEqual(f.queue(), []);
    assert.equal(existsSync(c.started), false);
    pause.resume();
    await until(() => existsSync(a.started), 'A admitted after complete publication');
    await until(
      () =>
        f.queue().length === 3 &&
        f
          .queue()
          .every((ticket) =>
            existsSync(join(f.common, 'georoids-validation-queue', ticket, 'owner.json'))
          ),
      'all three published tickets'
    );
    const ordered = f
      .queue()
      .sort()
      .map(
        (ticket) =>
          JSON.parse(
            readFileSync(join(f.common, 'georoids-validation-queue', ticket, 'owner.json'), 'utf8')
          ).pid
      );
    assert.equal(ordered[0], a.child.pid);
    const runs = [a, b, c];
    for (const pid of ordered) {
      const current = runs.find((run) => run.child.pid === pid);
      await until(() => existsSync(current.started), 'next published ticket admitted');
      for (const later of runs.filter(
        (run) => ordered.indexOf(run.child.pid) > ordered.indexOf(pid)
      )) {
        assert.equal(existsSync(later.started), false, 'Later ticket overtook its predecessor');
      }
      current.finish();
      assert.equal((await current.child.completed).code, 0, current.child.output);
    }
  }
  for (const run of [a, b, c]) {
    assert.equal((await run.child.completed).code, 0, run.child.output);
  }
  const intervals = [a, b, c]
    .map((run) => ({
      start: JSON.parse(readFileSync(run.started, 'utf8')).at,
      end: Number(readFileSync(`${run.started}.ended`, 'utf8')),
    }))
    .sort((left, right) => left.start - right.start);
  for (let i = 1; i < intervals.length; i += 1) {
    assert(intervals[i].start >= intervals[i - 1].end, 'Heavy command intervals overlapped');
  }
  assertReleased(f, [a, b, c]);
});

test('cancelling an allocation waiter leaves the live publisher owned and permits later progress', async (t) => {
  const f = fixture(t);
  const pause = pausePublication(f);
  const a = f.start('a', { preload: pause.preload });
  await until(() => existsSync(pause.ready), 'paused allocator');
  const bRoot = f.sibling('b');
  const b = f.start('b', { cwd: bRoot });
  await until(() => b.child.output.includes('ticket allocation'), 'allocation waiter');
  b.child.kill('SIGTERM');
  assert.notEqual((await b.child.completed).code, 0);
  assert.match(b.child.output, /allocation cancelled/u);
  assert.equal(existsSync(b.started), false);
  assert.equal(
    existsSync(
      join(f.git(bRoot, 'rev-parse', '--absolute-git-dir'), 'georoids-validation-checkout.lock')
    ),
    false
  );
  assert.equal(
    JSON.parse(
      readFileSync(join(f.common, 'georoids-validation-allocation.lock', 'owner.json'), 'utf8')
    ).pid,
    a.child.pid
  );
  pause.resume();
  await until(() => existsSync(a.started), 'original publisher admitted');
  const c = f.start('c', { cwd: bRoot });
  await until(() => c.child.output.includes('Waiting for heavy'), 'replacement waiter');
  a.finish();
  assert.equal((await a.child.completed).code, 0, a.child.output);
  await until(() => existsSync(c.started), 'replacement admitted');
  c.finish();
  assert.equal((await c.child.completed).code, 0, c.child.output);
  assertReleased(f, [a, c]);
});

for (const phase of ['ticket', 'allocation-owner', 'ticket-owner']) {
  test(`a dead allocator during ${phase} publication preserves its ownership and refuses new work`, async (t) => {
    const f = fixture(t);
    const pause = pausePublication(f, phase);
    const a = f.start('a', { preload: pause.preload });
    await until(() => existsSync(pause.ready), 'paused allocator');
    a.child.kill('SIGKILL');
    await a.child.completed;
    const allocation = join(f.common, 'georoids-validation-allocation.lock');
    const before = readdirSync(allocation).map((name) => [
      name,
      readFileSync(join(allocation, name), 'utf8'),
    ]);
    const b = f.start('b', { cwd: f.sibling('b') });
    assert.notEqual((await b.child.completed).code, 0);
    assert.match(
      b.child.output,
      phase === 'allocation-owner'
        ? /Untrustworthy validation allocation/u
        : /Dead validation allocator/u
    );
    assert.equal(existsSync(b.started), false);
    assert.deepEqual(f.queue(), phase === 'ticket-owner' ? ['000000000001'] : []);
    assert.deepEqual(
      readdirSync(allocation).map((name) => [name, readFileSync(join(allocation, name), 'utf8')]),
      before
    );
  });
}

for (const target of ['allocation', 'ticket']) {
  test(`failed ${target} owner publication releases its own incomplete allocation before another checkout enters`, async (t) => {
    const f = fixture(t);
    const preload = join(f.directory, 'failed-publication.mjs');
    const destination =
      target === 'allocation'
        ? join(f.common, 'georoids-validation-allocation.lock', 'owner.json')
        : join(f.common, 'georoids-validation-queue', '000000000001', 'owner.json');
    writeFileSync(
      preload,
      `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const rename = fs.renameSync;
fs.renameSync = function(from, to) {
  if (String(to) === ${JSON.stringify(destination)}) throw new Error('fixture publication failed');
  return rename.call(this, from, to);
};
syncBuiltinESMExports();
`
    );
    const a = f.start('failed', { preload });
    assert.notEqual((await a.child.completed).code, 0);
    assert.match(a.child.output, /fixture publication failed/u);
    assert.equal(existsSync(a.started), false);
    assertReleased(f, []);
    assert.equal(existsSync(join(f.common, 'georoids-validation-checkout.lock')), false);
    const b = f.start('next', { kind: 'runner' });
    await until(() => existsSync(b.started), 'next allocation after failed publication');
    b.finish();
    assert.equal((await b.child.completed).code, 0, b.child.output);
    assertReleased(f, [b]);
  });
}

// Controlled inspection errors exercise fail-closed ownership without startup races.
function inspectionFault(f, { target, failure } = {}) {
  const bin = mkdtempSync(join(f.directory, 'inspection-bin-'));
  const config = join(bin, 'config.json');
  const fired = join(bin, 'fired.json');
  const recovered = join(bin, 'recovered.json');
  writeFileSync(
    join(bin, 'ps'),
    `#!${process.execPath}
const fs = require('node:fs');
const cp = require('node:child_process');
const args = process.argv.slice(2);
const config = fs.existsSync(${JSON.stringify(config)}) ? JSON.parse(fs.readFileSync(${JSON.stringify(config)}, 'utf8')) : null;
function real() {
  const result = cp.spawnSync('/bin/ps', args, {stdio:'inherit'});
  process.exit(result.status ?? 1);
}
const matches = config && (config.target === 'group' ? (args[0] === '-axo' || args[0] === '-g') :
  args[0] === '-p' && args[2] === '-o' && args[3] === 'ppid=,stat=,lstart=' &&
  Number(args[1]) === (config.target === 'self' ? process.ppid : config.target));
if (!matches) real();
if (!fs.existsSync(${JSON.stringify(fired)})) {
  fs.writeFileSync(${JSON.stringify(fired)}, JSON.stringify({pid:process.pid,args,at:Date.now()}));
  if (config.failure === 'error') { process.stderr.write('inspection-unavailable\\n'); process.exit(2); }
  if (config.failure === 'permission') { process.stderr.write('Operation not permitted\\n'); process.exit(1); }
  if (config.failure === 'malformed') { process.stdout.write('invalid process row\\n'); process.exit(0); }
  throw new Error('Unknown fixture inspection failure');
} else {
  fs.writeFileSync(${JSON.stringify(recovered)}, JSON.stringify({pid:process.pid,args,at:Date.now()}));
  real();
}
`,
    { mode: 0o755 }
  );
  const arm = (nextTarget = target) =>
    writeFileSync(config, JSON.stringify({ target: nextTarget, failure }));
  if (target !== undefined) {
    arm();
  }
  return {
    environment: { PATH: `${bin}:${f.env.PATH}` },
    fired,
    recovered,
    arm,
  };
}
function queueOwner(f, run) {
  const directory = f
    .queue()
    .map((name) => join(f.common, 'georoids-validation-queue', name))
    .find(
      (path) => JSON.parse(readFileSync(join(path, 'owner.json'), 'utf8')).pid === run.child.pid
    );
  assert(directory, `No ticket for supervisor ${run.child.pid}`);
  return directory;
}

for (const failure of ['error', 'permission', 'malformed']) {
  test(`a waiting ${failure} inspection failure still refuses work instead of retrying`, async (t) => {
    const f = fixture(t);
    const a = f.start('owner');
    await until(() => existsSync(a.started), 'active owner');
    const active = queueOwner(f, a);
    const fault = inspectionFault(f, { target: a.child.pid, failure });
    const b = f.start('waiter', { cwd: f.sibling('waiter'), environment: fault.environment });
    assert.notEqual((await b.child.completed).code, 0);
    assert.match(
      b.child.output,
      failure === 'malformed' ? /Invalid process inspection/u : /Cannot inspect validation PID/u
    );
    assert.doesNotMatch(b.child.output, /process inspection timed out/u);
    assert.equal(existsSync(b.started), false);
    assert.equal(existsSync(fault.recovered), false);
    assert.deepEqual(f.queue(), [active.split('/').at(-1)]);
    assert(existsSync(join(active, 'active')));
    a.finish();
    assert.equal((await a.child.completed).code, 0, a.child.output);
    assertReleased(f, [a]);
    t.diagnostic(b.child.output);
  });
}

for (const operation of ['cancellation']) {
  test(`code integration ${operation} proves child disappearance before releasing checkout ownership`, async (t) => {
    const f = fixture(t);
    const worker = f.start('code', {
      kind: 'integration',
    });
    await until(() => existsSync(worker.started), 'integration child');
    const identity = JSON.parse(readFileSync(worker.started, 'utf8'));
    assert.deepEqual(f.queue(), []);
    worker.child.kill('SIGTERM');
    assert.equal((await worker.child.completed).code, 143, worker.child.output);
    assert(existsSync(`${worker.started}.ended`), 'child completed its cancellation handler');
    const current = spawnSync('ps', ['-p', String(identity.pid), '-o', 'lstart='], {
      encoding: 'utf8',
    });
    assert.notEqual(current.stdout.trim(), identity.start, 'owned command must be absent');
    assert.equal(existsSync(join(f.common, 'georoids-validation-checkout.lock')), false);
    assert.deepEqual(f.queue(), []);
  });
}

test('a cancelled command that never closes preserves ownership when its controlled grace expires', async (t) => {
  const f = fixture(t);
  const armed = join(f.directory, 'grace-armed');
  const expire = join(f.directory, 'expire-grace');
  const preload = join(f.directory, 'controlled-grace.mjs');
  writeFileSync(
    preload,
    `
import {existsSync,writeFileSync} from 'node:fs';
const realSet=globalThis.setTimeout, realClear=globalThis.clearTimeout;
const token={}; let grace;
globalThis.setTimeout=(callback,ms,...args)=>{
  if(ms!==45000)return realSet(callback,ms,...args);
  grace=()=>callback(...args); writeFileSync(${JSON.stringify(armed)},''); return token;
};
globalThis.clearTimeout=(timer)=>timer===token ? (grace=undefined) : realClear(timer);
const poll=setInterval(()=>{if(grace&&existsSync(${JSON.stringify(expire)})){const callback=grace;grace=undefined;callback();}},10);
poll.unref();
`
  );
  const worker = f.start('held', { kind: 'integration', proof: 'held-cleanup', preload });
  await until(() => existsSync(worker.started), 'ready cancellation handler');
  worker.child.kill('SIGTERM');
  await until(
    () => existsSync(armed) && existsSync(`${worker.started}.cleaning`),
    'controlled cancellation grace'
  );
  writeFileSync(expire, '');
  assert.equal((await worker.child.exited).code, 1);
  await until(
    () =>
      worker.child.output.includes('did not close within its cancellation grace period') &&
      worker.child.output.includes('Validation cleanup is unproven'),
    'failed cleanup diagnostics'
  );
  assert.match(worker.child.output, /did not close within its cancellation grace period/u);
  assert.match(worker.child.output, /Validation cleanup is unproven/u);
  assert(existsSync(join(f.common, 'georoids-validation-checkout.lock', 'owner.json')));
  assert.equal(existsSync(`${worker.started}.ended`), false);
  worker.finish();
  await until(
    () => existsSync(`${worker.started}.ended`),
    'owned command released after failed proof'
  );
  await worker.child.completed;
  assert(existsSync(join(f.common, 'georoids-validation-checkout.lock', 'owner.json')));
});

test('group cleanup waits for a surviving descendant and leaves a foreign group running', async (t) => {
  const f = fixture(t);
  const census = join(f.directory, 'group-census.jsonl');
  const leaderIdentity = join(f.directory, 'leader.json');
  const preload = join(f.directory, 'record-group-inspection.mjs');
  writeFileSync(
    preload,
    `
import cp from 'node:child_process';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
const real = cp.spawnSync;
cp.spawnSync = (file,args,options) => {
  const result = real(file,args,options);
  if(file === 'ps' && (args[0] === '-g' || args[0] === '-axo')) {
    fs.appendFileSync(${JSON.stringify(census)},JSON.stringify({args,status:result.status,stdout:result.stdout,stderr:result.stderr,error:result.error?.message,signal:result.signal})+'\\n');
  }
  return result;
};
syncBuiltinESMExports();
`
  );
  const foreign = f.start('foreign', { cwd: f.sibling('foreign'), kind: 'integration' });
  await until(() => existsSync(foreign.started), 'foreign command');
  const foreignIdentity = JSON.parse(readFileSync(foreign.started, 'utf8'));
  const own = f.start('own', {
    kind: 'integration',
    preload,
    command: [
      process.execPath,
      '-e',
      `
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(leaderIdentity)},JSON.stringify({pid:process.pid}));
const child = require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(childScript)},${JSON.stringify(join(f.directory, 'own.started'))},${JSON.stringify(join(f.directory, 'own.release'))},'clean'],{stdio:'ignore'});
child.unref();
const poll = setInterval(()=>{if(fs.existsSync(${JSON.stringify(join(f.directory, 'own.started'))})){clearInterval(poll);process.exit(0);}},10);
`,
    ],
  });
  const records = () =>
    existsSync(census)
      ? readFileSync(census, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : [];
  await until(
    () => existsSync(own.started) && records().length > 0,
    'orphaned owned descendant inspection'
  );
  const leader = JSON.parse(readFileSync(leaderIdentity, 'utf8')).pid;
  const descendant = JSON.parse(readFileSync(own.started, 'utf8')).pid;
  const observed = records().find((record) =>
    record.stdout.split('\n').some((line) => {
      const [pid, group] = line.trim().split(/\s+/u);
      return Number(pid) === descendant && Number(group) === leader;
    })
  );
  assert(observed, 'the real inspector sees the descendant after its leader exited');
  assert.equal(own.child.exitCode, null);
  assert(existsSync(join(f.common, 'georoids-validation-checkout.lock')));
  if (process.platform === 'darwin') {
    assert.deepEqual(observed.args, ['-g', String(leader), '-o', 'pid=,pgid=,stat=']);
    assert(
      observed.stdout
        .split('\n')
        .filter(Boolean)
        .every((line) => Number(line.trim().split(/\s+/u)[1]) === leader)
    );
    assert(
      !observed.stdout
        .split('\n')
        .some((line) => Number(line.trim().split(/\s+/u)[0]) === foreignIdentity.pid)
    );
  }
  own.finish();
  assert.equal((await own.child.completed).code, 0, own.child.output);
  assert.equal(
    foreign.child.exitCode,
    null,
    'cleanup does not wait for or signal the foreign group'
  );
  const descendantFinished = records().at(-1);
  const ownedRows = descendantFinished.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => line.trim().split(/\s+/u))
    .filter(([, group]) => Number(group) === leader);
  assert(
    ownedRows.every(([, , state]) => state.includes('Z')),
    'no live owned descendants remain'
  );
  // A directly reaped command has no remaining group members, including zombies.
  const empty = f.start('empty', { kind: 'integration', preload });
  await until(() => existsSync(empty.started), 'ordinary owned command');
  empty.finish();
  assert.equal((await empty.child.completed).code, 0, empty.child.output);
  const final = records().at(-1);
  if (process.platform === 'darwin') {
    assert.equal(final.status, 1);
    assert.equal(final.stdout, '');
    assert.equal(final.stderr, '');
    assert.equal(final.signal, null);
    assert.equal(final.error, undefined);
  }
  foreign.finish();
  assert.equal((await foreign.child.completed).code, 0, foreign.child.output);
});

for (const failure of [
  'permission',
  'absent-row',
  'absent-whitespace',
  'absent-stderr-whitespace',
  'malformed',
  'wrong-group',
  'signal',
  'timeout',
]) {
  test(`a ${failure} group inspection cannot release ownership`, async (t) => {
    const f = fixture(t);
    const armed = join(f.directory, 'fault-armed');
    const preload = join(f.directory, 'fail-group-inspection.mjs');
    writeFileSync(
      preload,
      `
import cp from 'node:child_process';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
const real = cp.spawnSync;
cp.spawnSync = (file,args,options) => {
  if(file !== 'ps' || !fs.existsSync(${JSON.stringify(armed)}) || !['-g','-axo'].includes(args[0])) return real(file,args,options);
  const failure = ${JSON.stringify(failure)};
  if(failure === 'wrong-group' && process.platform !== 'darwin') return {status:1,signal:null,stdout:'1 1 S\\n',stderr:''};
  if(failure === 'wrong-group') return {status:0,signal:null,stdout:'1 '+(Number(args[1])+1)+' S\\n',stderr:''};
  if(failure === 'permission') return {status:1,signal:null,stdout:'',stderr:'Operation not permitted'};
  if(failure === 'absent-row') return {status:1,signal:null,stdout:'1 1 S\\n',stderr:''};
  if(failure === 'absent-whitespace') return {status:1,signal:null,stdout:' ',stderr:''};
  if(failure === 'absent-stderr-whitespace') return {status:1,signal:null,stdout:'',stderr:' '};
  if(failure === 'malformed') return {status:0,signal:null,stdout:'invalid row',stderr:''};
  if(failure === 'signal') return {status:1,signal:'SIGTERM',stdout:'',stderr:''};
  return {status:1,signal:null,error:Object.assign(new Error('fixture inspection timeout'),{code:'ETIMEDOUT'}),stdout:'',stderr:''};
};
syncBuiltinESMExports();
`
    );
    const owned = f.start('fault', { kind: 'integration', preload });
    await until(() => existsSync(owned.started), 'owned command before inspector failure');
    writeFileSync(armed, '');
    owned.finish();
    assert.equal((await owned.child.completed).code, 1, owned.child.output);
    assert.match(
      owned.child.output,
      failure === 'wrong-group' && process.platform === 'darwin'
        ? /Unexpected validation process group inspection/u
        : failure === 'malformed'
          ? /Malformed validation process group inspection/u
          : /Cannot inspect validation process group/u
    );
    assert(existsSync(join(f.common, 'georoids-validation-checkout.lock', 'owner.json')));
    assert.match(owned.child.output, /Validation cleanup is unproven/u);
  });
}
