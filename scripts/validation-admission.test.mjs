import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
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
fs.writeFileSync(started, JSON.stringify({pid:process.pid, start, env:Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('GEOROIDS_VALIDATION_')))}));
function finish() {
  if (process.env.GEOROIDS_TEST_RUNNER_RECEIPT && proof !== 'missing') {
    fs.writeFileSync(process.env.GEOROIDS_TEST_RUNNER_RECEIPT, JSON.stringify({
      kind:'georoids-runner-final', worktree:fs.realpathSync(process.cwd()),
      ownerPid:process.pid, cleanupSucceeded:proof !== 'failed',
      lockReleased:true, sessionRemoved:true
    }));
  }
  process.exit(proof === 'test-failed' ? 1 : 0);
}
let cleaning = false;
function cancel() {
  if (cleaning) {
    if (proof === 'first-forward') fs.writeFileSync(started + '.forwarded', '');
    return;
  }
  cleaning = true;
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
  const directory = mkdtempSync(join(tmpdir(), 'georoids-admission-'));
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
    { cwd = root, kind = 'review', proof = 'clean', environment = {}, command } = {}
  ) {
    const started = join(directory, `${name}.started`);
    const release = join(directory, `${name}.release`);
    workers.push(started);
    const child = spawn(
      process.execPath,
      [
        helper,
        kind,
        '--',
        ...(command || [process.execPath, '-e', childScript, started, release, proof]),
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

test('linked checkouts enter heavy validation in ticket order and cancelled waiters leave the queue', async (t) => {
  const f = fixture(t);
  const a = f.start('a', { kind: 'contracts' });
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

test('active cancellation waits for the runner cleanup receipt before allowing the next checkout', async (t) => {
  const f = fixture(t);
  const runner = f.start('runner', { kind: 'runner' });
  await until(() => existsSync(runner.started), 'runner child');
  const next = f.start('next', { cwd: f.sibling('next') });
  await until(() => next.child.output.includes('Waiting for heavy'), 'next waiting');
  runner.child.kill('SIGTERM');
  await delay(100);
  assert.equal(existsSync(next.started), false);
  assert.equal((await runner.child.completed).code, 143, runner.child.output);
  await until(() => {
    assert.equal(next.child.exitCode, null, next.child.output);
    return existsSync(next.started);
  }, 'next child after cleanup');
  next.finish();
  assert.equal((await next.child.completed).code, 0, next.child.output);
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

function failingInspection(f, mode) {
  const bin = join(f.directory, 'bin');
  const fail = join(f.directory, 'inspection-fails');
  mkdirSync(bin);
  writeFileSync(
    join(bin, 'ps'),
    `#!${process.execPath}
const args = process.argv.slice(2);
if (require('node:fs').existsSync(${JSON.stringify(fail)}) &&
    args[0] === ${JSON.stringify(mode === 'group' ? '-axo' : '-p')}) {
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

for (const inspection of ['group', 'pid']) {
  test(`failed ${inspection} inspection during cancellation exits without signaling the child or releasing barriers`, async (t) => {
    const f = fixture(t);
    const mock = failingInspection(f, inspection);
    const runner = f.start('runner', { kind: 'runner', environment: mock.environment });
    await until(() => existsSync(runner.started), 'runner child');
    const checkout = join(f.common, 'georoids-validation-checkout.lock');
    const queue = join(f.common, 'georoids-validation-queue', f.queue()[0]);
    const owned = JSON.parse(readFileSync(runner.started, 'utf8'));
    await until(
      () =>
        readdirSync(join(checkout, 'children')).some((name) => {
          const record = JSON.parse(readFileSync(join(checkout, 'children', name), 'utf8'));
          return record.command?.pid === owned.pid;
        }),
      'recorded command identity before cancelling'
    );
    mock.fail();
    runner.child.kill('SIGTERM');
    // Wait for exit, not close: the surviving command inherits the output pipes.
    await until(() => runner.child.exitCode !== null, 'failed cancellation supervisor exit');
    assert.equal((await runner.child.exited).code, 1, runner.child.output);
    await until(() => runner.child.output.includes(queue), 'preserved ownership diagnostic');
    assert.match(runner.child.output, /Cannot forward SIGTERM: Cannot inspect validation/u);
    assert.match(runner.child.output, /"status":2,"signal":null,"error":null/u);
    assert.match(runner.child.output, /"stderr":"inspection-unavailable/u);
    assert.match(runner.child.output, /owned command may still be running/u);
    assert(runner.child.output.includes(checkout));
    assert(existsSync(join(checkout, 'owner.json')));
    assert(existsSync(join(queue, 'active')));
    const records = readdirSync(join(checkout, 'children')).map((name) =>
      JSON.parse(readFileSync(join(checkout, 'children', name), 'utf8'))
    );
    assert(records.some((record) => record.command.pid === owned.pid && !record.finished));
    // A forwarded TERM would finish this fixture after 250 ms.
    await delay(400);
    const current = spawnSync('/bin/ps', ['-p', String(owned.pid), '-o', 'lstart='], {
      encoding: 'utf8',
    });
    assert.equal(current.status, 0, 'Unauthenticated cancellation must not signal the child');
    assert.equal(current.stdout.trim(), owned.start);
    const next = f.start('next', { cwd: f.sibling('next') });
    assert.notEqual((await next.child.completed).code, 0);
    assert.match(next.child.output, /Dead validation owner requires cleanup verification/u);
    assert.equal(existsSync(next.started), false);
    // fixture() authenticates this exact PID and birth before final cleanup.
  });
}

test('failed group inspection after the command exits preserves both ownership barriers', async (t) => {
  const f = fixture(t);
  const mock = failingInspection(f, 'group');
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
