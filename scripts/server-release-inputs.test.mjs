import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import { requiresServerDeployment, serverReleaseInputs } from './server-release-inputs.mjs';

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));

test('shared modules and manifests require a server release; client sources do not', () => {
  const inheritedGit = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key.startsWith('GIT_'))
  );
  for (const key of Object.keys(inheritedGit)) {
    delete process.env[key];
  }
  const cwd = mkdtempSync(join(tmpdir(), 'georoids-server-inputs-'));
  const git = (...args) =>
    execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
      cwd,
      env: Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))
      ),
      encoding: 'utf8',
    }).trim();
  const write = (name, text) => {
    mkdirSync(dirname(join(cwd, name)), { recursive: true });
    writeFileSync(join(cwd, name), text);
  };
  const commit = (message) => {
    git(
      'add',
      'server.ts',
      'tsconfig.json',
      'package.json',
      'astro.config.mjs',
      'src/runtime.ts',
      'src/render.ts',
      'shared/state.ts',
      '.mise.toml',
      'config'
    );
    git('commit', '-qm', message);
    return git('rev-parse', 'HEAD');
  };
  try {
    git('init', '-q');
    git('config', 'user.name', 'Smoke contract');
    git('config', 'user.email', 'smoke@example.invalid');
    mkdirSync(join(cwd, 'src'));
    mkdirSync(join(cwd, 'shared'));
    write('package.json', '{"private":true}');
    write('.mise.toml', '[tools]\nnode = "26"\n');
    write('astro.config.mjs', 'export default {};');
    // Retired owners model historical diffs; the current native owner is checked too.
    write('tsconfig.json', '{"extends":"./config/typescript/project.json"}');
    write(
      'config/typescript/project.json',
      '{"extends":"./strict-tsc.json","compilerOptions":{"module":"ESNext","moduleResolution":"bundler"}}'
    );
    write('config/typescript/strict-tsc.json', '{}');
    write('config/typescript/tsconfig.json', '{}');
    write('config/typescript/build.json', '{"extends":"./project.json"}');
    write('config/app/astro.ts', 'export default {};');
    write('config/app/svelte.js', 'export default {};');
    write('config/app/svelte.ts', 'export default {};');
    write('config/server/debug-reports.json', '{}');
    write('config/quality/prettier.json', '{}');
    write('server.ts', "import { factor } from './shared/state'; console.log(factor);");
    write(
      'src/runtime.ts',
      "import { factor } from '../shared/state'; export const speed = factor * 2;"
    );
    write('shared/state.ts', 'export const factor = 1;');
    write('src/render.ts', 'export const color = "red";');
    const initial = commit('initial server');
    const inputs = serverReleaseInputs(cwd);
    assert.ok(inputs.includes('shared/state.ts'));
    assert.deepEqual(
      inputs.filter((path) => path.startsWith('src/')),
      []
    );
    write('src/render.ts', 'export const color = "blue";');
    const ui = commit('client only');
    assert.equal(requiresServerDeployment(initial, ui, cwd), false);
    write('shared/state.ts', 'export const factor = 3;');
    const shared = commit('shared runtime');
    assert.equal(requiresServerDeployment(ui, shared, cwd), true);
    write(
      'src/runtime.ts',
      "import { factor } from '../shared/state'; export const speed = factor * 4;"
    );
    const runtime = commit('client gameplay');
    assert.equal(requiresServerDeployment(shared, runtime, cwd), false);
    write('astro.config.mjs', 'export default {output: "static"};');
    const config = commit('Astro build configuration');
    assert.equal(requiresServerDeployment(runtime, config, cwd), true);
    let previous = config;
    for (const path of [
      '.mise.toml',
      'config/typescript/project.json',
      'config/typescript/tsconfig.json',
      'config/typescript/build.json',
      'config/typescript/strict-tsc.json',
      'config/app/astro.ts',
      'config/app/svelte.js',
      'config/app/svelte.ts',
      'config/server/debug-reports.json',
    ]) {
      assert.ok(serverReleaseInputs(cwd).includes(path), path);
      write(path, `${readFileSync(join(cwd, path), 'utf8')}\n`);
      const changed = commit(`central build settings: ${path}`);
      assert.equal(requiresServerDeployment(previous, changed, cwd), true, path);
      previous = changed;
    }
    write('config/quality/prettier.json', '{"singleQuote":true}');
    const quality = commit('quality settings only');
    assert.equal(requiresServerDeployment(previous, quality, cwd), false);
    // Adding or removing a mise lock changes what Railpack installs, as #929 and #930 did.
    write('mise.lock', '');
    git('add', 'mise.lock');
    git('commit', '-qm', 'lock mise tools');
    const locked = git('rev-parse', 'HEAD');
    assert.ok(serverReleaseInputs(cwd).includes('mise.lock'));
    assert.equal(requiresServerDeployment(quality, locked, cwd), true);
    git('rm', '-q', 'mise.lock');
    git('commit', '-qm', 'unlock mise tools');
    assert.equal(requiresServerDeployment(locked, git('rev-parse', 'HEAD'), cwd), true);
    assert.throws(() => requiresServerDeployment(initial, ui, cwd), /target commit checkout/u);
    assert.throws(
      () => requiresServerDeployment('--all', config, cwd),
      /full lowercase commit SHA/u
    );
    write('shared/state.ts', "import { color } from '../src/render'; export const factor = color;");
    commit('shared reaches into the client');
    assert.throws(() => serverReleaseInputs(cwd), /client sources: src\/render\.ts/u);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    Object.assign(process.env, inheritedGit);
  }
});

test('the Railway server build is given no mise lock', () => {
  const tracked = execFileSync('git', ['ls-files', '-z', '--', 'mise.lock', '.mise/locks'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  })
    .split('\0')
    .filter(Boolean);
  assert.deepEqual(
    tracked,
    [],
    'Do not track mise.lock or .mise/locks/. Railpack copies .mise.toml and mise.lock, but not ' +
      'the .mise/locks/ sidecars, into the Railway image and runs `mise install` with its own ' +
      'mise, which then fails and stops the Railway server build (#929 broke production; #930 ' +
      'removed the lock). Lift this only for a lock form that the mise bundled in Railpack on ' +
      'Railway accepts, proven by a successful Railway build of that commit.'
  );
});

test('the GeoRoids server graph loads no client sources', () => {
  const inputs = serverReleaseInputs(repositoryRoot);
  assert.ok(inputs.includes('server.ts'));
  assert.ok(inputs.includes('shared/shipAbilities.ts'));
  assert.deepEqual(
    inputs.filter((path) => path.startsWith('src/')),
    []
  );
});
