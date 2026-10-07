import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const helper = fileURLToPath(new URL('./benchmark-build-receipt.mjs', import.meta.url));
const websocketUrl = 'ws://localhost:59995/ws';

test('repeated owned sessions reuse only the exact successfully built client', () => {
  const root = mkdtempSync(join(tmpdir(), 'georoids-frozen-build-'));
  const prepared = join(root, '.performance/prepared.json');
  const receipt = join(root, '.performance/benchmark-client-build.json');
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))
  );
  const git = (...args) => execFileSync('git', args, { cwd: root, env, stdio: 'pipe' });
  const run = (action, url = websocketUrl, extraEnvironment = {}) =>
    spawnSync(
      process.execPath,
      [helper, action, root, ...(action === 'ports' ? [] : [url, prepared])],
      {
        env: {
          ...env,
          GEOROIDS_TEST_VITE_PORT: '59993',
          GEOROIDS_TEST_SERVER_PORT: '59994',
          GEOROIDS_TEST_PROXY_PORT: '59995',
          ...extraEnvironment,
        },
        encoding: 'utf8',
        timeout: 10_000,
      }
    );
  const passes = (result) => assert.equal(result.status, 0, result.stderr);
  const rejects = (result, message) => {
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, message);
  };
  try {
    git('init', '-q');
    git(
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      '-c',
      'core.hooksPath=/dev/null',
      'commit',
      '--allow-empty',
      '-qm',
      'fixture'
    );
    mkdirSync(join(root, 'src'));
    mkdirSync(join(root, 'benchmarks'));
    mkdirSync(join(root, 'public/wiki'), { recursive: true });
    mkdirSync(join(root, 'dist/assets'), { recursive: true });
    const files = {
      'src/game.ts': 'product',
      'benchmarks/scene.ts': 'harness',
      'public/wiki/index.html': 'wiki',
      'package-lock.json': 'lock',
      '.env.production.local': 'VITE_OTHER=value',
      'dist/index.html': '<script src="/assets/game.js"></script>',
      'dist/release.json': '{"releaseSha":"fixture"}',
      'dist/assets/game.js': 'built client',
    };
    writeFileSync(join(root, '.gitignore'), '.env.*.local\ndist/\n.performance/\n');
    for (const [path, content] of Object.entries(files)) {
      writeFileSync(join(root, path), content);
    }
    rejects(run('verify'), /Missing successful benchmark-client build receipt/u);
    passes(run('prepare'));
    passes(run('record'));
    const originalReceipt = readFileSync(receipt, 'utf8');
    const recovered = run('ports');
    passes(recovered);
    assert.equal(recovered.stdout, '59993\n59994\n59995\n');
    for (const [field, value, diagnostic] of [
      ['schemaVersion', 1, /Unsupported benchmark build receipt/u],
      [
        'inputs',
        { ...JSON.parse(originalReceipt).inputs, ports: [0, 59994, 59995] },
        /valid, distinct benchmark ports/u,
      ],
      [
        'inputs',
        { ...JSON.parse(originalReceipt).inputs, ports: [59993, 59993, 59995] },
        /valid, distinct benchmark ports/u,
      ],
      [
        'inputs',
        { ...JSON.parse(originalReceipt).inputs, worktree: '/another/worktree' },
        /another worktree/u,
      ],
    ]) {
      writeFileSync(receipt, JSON.stringify({ ...JSON.parse(originalReceipt), [field]: value }));
      rejects(run('ports'), diagnostic);
      rejects(run('verify'), diagnostic);
    }
    writeFileSync(receipt, originalReceipt);
    for (let index = 0; index < 3; index++) {
      passes(run('verify'));
      assert.equal(readFileSync(receipt, 'utf8'), originalReceipt);
    }
    for (const path of [
      'src/game.ts',
      'benchmarks/scene.ts',
      'public/wiki/index.html',
      'package-lock.json',
      '.env.production.local',
    ]) {
      writeFileSync(join(root, path), 'changed');
      rejects(run('verify'), /Reusable build inputs differ/u);
      writeFileSync(join(root, path), files[path]);
    }
    for (const path of ['dist/assets/game.js', 'dist/index.html']) {
      writeFileSync(join(root, path), 'changed');
      rejects(run('verify'), /Reusable production assets differ/u);
      writeFileSync(join(root, path), files[path]);
    }
    rmSync(join(root, 'dist/assets/game.js'));
    rejects(run('verify'), /Reusable production assets differ/u);
    writeFileSync(join(root, 'dist/assets/game.js'), files['dist/assets/game.js']);
    writeFileSync(join(root, 'dist/extra.js'), 'unexpected asset');
    rejects(run('verify'), /Reusable production assets differ/u);
    rmSync(join(root, 'dist/extra.js'));
    rejects(run('verify', 'ws://localhost:59996/ws'), /Reusable build inputs differ/u);
    for (const variable of [
      'GEOROIDS_TEST_VITE_PORT',
      'GEOROIDS_TEST_SERVER_PORT',
      'GEOROIDS_TEST_PROXY_PORT',
    ]) {
      rejects(
        run('verify', websocketUrl, { [variable]: '59996' }),
        /Reusable build inputs differ/u
      );
    }
    rejects(
      run('verify', websocketUrl, { VITE_OTHER: 'changed' }),
      /Reusable build inputs differ/u
    );
    rejects(
      run('verify', websocketUrl, { GEOROIDS_TEST_SESSION_DIR: '/another/session' }),
      /Reusable build inputs differ/u
    );
    passes(run('prepare'));
    rejects(run('verify'), /Missing successful benchmark-client build receipt/u);
    writeFileSync(join(root, 'src/game.ts'), 'changed during build');
    rejects(run('record'), /Build inputs changed during build/u);
    rejects(run('verify'), /Missing successful benchmark-client build receipt/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
