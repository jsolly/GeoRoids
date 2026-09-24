import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { test } from 'node:test';
import {
  minimumServerRelease,
  requiresServerDeployment,
  serverReleaseInputs,
} from './server-release-inputs.mjs';

test('shared and server-consumed client modules require a server release; unrelated UI does not', () => {
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
    write('tsconfig.json', '{"compilerOptions":{"module":"ESNext","moduleResolution":"bundler"}}');
    write('server.ts', "import { speed } from './src/runtime'; console.log(speed);");
    write(
      'src/runtime.ts',
      "import { factor } from '../shared/state'; export const speed = factor * 2;"
    );
    write('shared/state.ts', 'export const factor = 1;');
    write('src/render.ts', 'export const color = "red";');
    const initial = commit('initial server');
    assert.ok(serverReleaseInputs(cwd).includes('src/runtime.ts'));
    assert.ok(!serverReleaseInputs(cwd).includes('src/render.ts'));
    write('src/render.ts', 'export const color = "blue";');
    const ui = commit('client only');
    assert.equal(minimumServerRelease(ui, cwd), initial);
    assert.equal(requiresServerDeployment(initial, ui, cwd), false);
    write('shared/state.ts', 'export const factor = 3;');
    const shared = commit('shared runtime');
    assert.equal(minimumServerRelease(shared, cwd), shared);
    assert.equal(requiresServerDeployment(ui, shared, cwd), true);
    write(
      'src/runtime.ts',
      "import { factor } from '../shared/state'; export const speed = factor * 4;"
    );
    const runtime = commit('server consumed gameplay');
    assert.equal(minimumServerRelease(runtime, cwd), runtime);
    assert.equal(requiresServerDeployment(shared, runtime, cwd), true);
    assert.throws(() => minimumServerRelease(ui, cwd), /target commit checkout/u);
    assert.throws(() => minimumServerRelease('--all', cwd), /full lowercase commit SHA/u);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    Object.assign(process.env, inheritedGit);
  }
});
