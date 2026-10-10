/* @vitest-environment node */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, test, vi } from 'vitest';

const roots: string[] = [];
const sha = 'a'.repeat(40);
const checker = fileURLToPath(new URL('../../../scripts/check-built-client.mjs', import.meta.url));

function checkArchive(root: string) {
  return spawnSync(process.execPath, [checker], {
    cwd: root,
    env: process.env,
    encoding: 'utf8',
    timeout: 10_000,
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function archive() {
  const root = mkdtempSync(join(tmpdir(), 'georoids-hosted-build-'));
  roots.push(root);
  for (const path of ['dist/debug', 'dist/wiki', 'dist/_astro', 'content/wiki']) {
    mkdirSync(join(root, path), { recursive: true });
  }
  const document = (body: string) =>
    `<!doctype html><html><head><title>GeoRoids</title><link rel="canonical" href="https://www.georoids.com/"></head><body>${body}</body></html>`;
  const game = document(
    '<canvas id="gameCanvas"></canvas><script type="module" src="/_astro/game.js"></script>'
  );
  writeFileSync(join(root, 'dist/index.html'), game);
  writeFileSync(join(root, 'dist/debug/index.html'), game);
  writeFileSync(
    join(root, 'dist/wiki/index.html'),
    document(
      '<section id="content"><h1>Manual</h1></section><section id="ships"></section><article id="controls" data-panel="article"><h1>Controls</h1><p>Steer.</p></article>'
    )
  );
  writeFileSync(join(root, 'content/wiki/controls.md'), '# Controls\n');
  writeFileSync(join(root, 'dist/_astro/game.js'), `console.log('${sha}');`);
  writeFileSync(join(root, 'dist/release.json'), JSON.stringify({ releaseSha: sha }));
  writeFileSync(
    join(root, 'dist/client-assets.json'),
    JSON.stringify({
      releaseSha: sha,
      gameplay: ['_astro/game.js'],
      modules: { '_astro/game.js': [] },
    })
  );
  return root;
}

test.each(['VERCEL_GIT_COMMIT_SHA', 'RAILWAY_GIT_COMMIT_SHA'])(
  'a hosted archive passes output checks using %s without a Git checkout',
  (variable) => {
    vi.stubEnv('VERCEL_GIT_COMMIT_SHA', '');
    vi.stubEnv('RAILWAY_GIT_COMMIT_SHA', '');
    vi.stubEnv(variable, sha.toUpperCase());
    const result = checkArchive(archive());
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`3 static routes, 1 modules, ${sha}`);
  }
);

test('a hosted archive rejects output built for another release', () => {
  vi.stubEnv('VERCEL_GIT_COMMIT_SHA', '');
  vi.stubEnv('RAILWAY_GIT_COMMIT_SHA', 'b'.repeat(40));
  const result = checkArchive(archive());
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('Built release identity differs');
});
