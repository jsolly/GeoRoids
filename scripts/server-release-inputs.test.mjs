import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
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
  const write = (name, text) => writeFileSync(join(cwd, name), text);
  const commit = (message) => {
    git(
      'add',
      'server.ts',
      'tsconfig.json',
      'package.json',
      'astro.config.mjs',
      'src/runtime.ts',
      'src/render.ts',
      'shared/state.ts'
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
    write('astro.config.mjs', 'export default {};');
    write('tsconfig.json', '{"compilerOptions":{"module":"ESNext","moduleResolution":"bundler"}}');
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

test('the GeoRoids server graph loads no client sources', () => {
  const inputs = serverReleaseInputs(repositoryRoot);
  assert.ok(inputs.includes('server.ts'));
  assert.ok(inputs.includes('shared/shipAbilities.ts'));
  assert.deepEqual(
    inputs.filter((path) => path.startsWith('src/')),
    []
  );
});
