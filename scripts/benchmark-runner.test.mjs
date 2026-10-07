import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const source = dirname(fileURLToPath(import.meta.url));
function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'manual-benchmark-contract-')));
  t.after(() => {
    if (
      existsSync(join(root, '.git/georoids-validation-checkout.lock')) ||
      existsSync(join(root, '.git/georoids-test-runner.lock'))
    ) {
      t.diagnostic(`Unproven fixture cleanup retained at ${root}`);
      return;
    }
    rmSync(root, { recursive: true, force: true });
  });
  const scripts = join(root, 'scripts'),
    bin = join(root, 'bin');
  mkdirSync(scripts);
  mkdirSync(bin);
  for (const name of [
    'test-runner.sh',
    'benchmark-runner.sh',
    'process-tree.sh',
    'test-runner-ports.sh',
    'test-ports.mjs',
    'validation-admission.mjs',
    'benchmark-build-receipt.mjs',
  ]) {
    cpSync(join(source, name), join(scripts, name));
  }
  writeFileSync(
    join(scripts, 'review-receipt.mjs'),
    `import {writeFileSync,existsSync} from 'node:fs'; const [kind,directory,destination,mode,worktree,pid,started,code,cleaned,timedOut,held,session]=process.argv.slice(2); writeFileSync(destination,JSON.stringify({kind:'georoids-runner-final',mode,worktree,ownerPid:Number(pid),exitCode:Number(code),cleanupSucceeded:cleaned==='true',lockReleased:held==='false',sessionRemoved:!session||!existsSync(session),timedOut:timedOut==='true'}));`
  );
  writeFileSync(join(root, '.env.example'), '');
  writeFileSync(join(root, 'package-lock.json'), '{"lockfileVersion":3}');
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.startsWith('GIT_') && !key.startsWith('GEOROIDS_')
    )
  );
  Object.assign(env, {
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    PATH: `${bin}:${env.PATH}`,
    BENCHMARK_RECORDS: join(root, 'records'),
    GEOROIDS_TEST_MAX_DURATION_SECONDS: '10',
    GEOROIDS_TEST_RUNNER_RECEIPT: join(root, 'runner.json'),
  });
  const git = (...args) => {
    const result = spawnSync('git', ['-C', root, ...args], { env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };
  git('init', '-q');
  git(
    '-c',
    'core.hooksPath=/dev/null',
    '-c',
    'user.name=fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '--allow-empty',
    '-qm',
    'fixture'
  );
  function executable(name, contents) {
    writeFileSync(join(bin, name), contents, { mode: 0o755 });
  }
  executable('curl', '#!/bin/sh\nexit 0\n');
  executable(
    'lsof',
    '#!/bin/sh\nif [ -s "$BENCHMARK_RECORDS.pid" ]; then cat "$BENCHMARK_RECORDS.pid"; else exit 1; fi\n'
  );
  executable(
    'npm',
    `#!/usr/bin/env node\nconst fs=require('node:fs');fs.appendFileSync(process.env.BENCHMARK_RECORDS,JSON.stringify({kind:'build',args:process.argv.slice(2)})+'\\n');process.exit(process.env.FAIL_BUILD==='1'?23:0);\n`
  );
  executable(
    'npx',
    `#!/usr/bin/env node\nconst fs=require('node:fs'); const args=process.argv.slice(2); const services=args.includes('concurrently'); fs.appendFileSync(process.env.BENCHMARK_RECORDS,JSON.stringify({kind:services?'services':'measurement',pid:process.pid,args})+'\\n'); if(services){fs.writeFileSync(process.env.BENCHMARK_RECORDS+'.pid',String(process.pid));process.on('SIGTERM',()=>{fs.appendFileSync(process.env.BENCHMARK_RECORDS,JSON.stringify({kind:'services-closed',pid:process.pid})+'\\n');process.exit(0)});setInterval(()=>{},1000);}else process.exit(0);\n`
  );
  function run(args, extras = {}) {
    return spawnSync('bash', [join(scripts, 'test-runner.sh'), ...args], {
      cwd: root,
      env: { ...env, ...extras },
      encoding: 'utf8',
      timeout: 20000,
    });
  }
  function records() {
    return existsSync(env.BENCHMARK_RECORDS)
      ? readFileSync(env.BENCHMARK_RECORDS, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : [];
  }
  return { root, run, records };
}

test('manual load measurements retain their services until the owned measurement finishes, then prove cleanup', (t) => {
  const f = fixture(t),
    result = f.run(['--benchmark-load', '--scenario', 'traversal', '--seed', '42']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const records = f.records();
  assert.deepEqual(
    records.map((row) => row.kind),
    ['build', 'services', 'measurement', 'services-closed']
  );
  assert(records[1].args.some((arg) => arg.includes('benchmarks/realtime-server.ts')));
  assert(records[2].args.includes('benchmarks/load.ts'));
  const receipt = JSON.parse(readFileSync(join(f.root, 'runner.json'), 'utf8'));
  assert.equal(receipt.cleanupSucceeded, true);
  assert.equal(receipt.lockReleased, true);
  assert.equal(receipt.sessionRemoved, true);
  assert.equal(existsSync(join(f.root, '.git/georoids-test-runner.lock')), false);
  assert.equal(existsSync(join(f.root, '.git/georoids-validation-checkout.lock')), false);
});
test('a failed production build starts no manual service or measurement and releases proven ownership', (t) => {
  const f = fixture(t),
    result = f.run(['--benchmark-load'], { FAIL_BUILD: '1' });
  assert.notEqual(result.status, 0);
  assert.deepEqual(
    f.records().map((row) => row.kind),
    ['build']
  );
  assert.equal(
    JSON.parse(readFileSync(join(f.root, 'runner.json'), 'utf8')).cleanupSucceeded,
    true
  );
  assert.equal(existsSync(join(f.root, '.git/georoids-validation-checkout.lock')), false);
});
test('frozen client reuse without a valid build receipt starts no services and performs no replacement build', (t) => {
  const f = fixture(t),
    result = f.run(['--benchmark-client', '--reuse-build']);
  assert.notEqual(result.status, 0);
  assert.deepEqual(f.records(), []);
  assert.equal(existsSync(join(f.root, '.git/georoids-validation-checkout.lock')), false);
});
