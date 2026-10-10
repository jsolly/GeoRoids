/* @vitest-environment node */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, test } from 'vitest';

const roots: string[] = [];
const sha = 'a'.repeat(40);
const checker = fileURLToPath(new URL('../../../scripts/check-built-client.mjs', import.meta.url));

function checkArchive(root: string, metadata: Record<string, string>) {
  return spawnSync(process.execPath, [checker], {
    cwd: root,
    env: { ...process.env, ...metadata },
    encoding: 'utf8',
    timeout: 10_000,
  });
}

afterEach(() => {
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

test.each([
  { VERCEL_GIT_COMMIT_SHA: '', RAILWAY_GIT_COMMIT_SHA: '' },
  { VERCEL_GIT_COMMIT_SHA: 'not-a-sha', RAILWAY_GIT_COMMIT_SHA: '' },
  { VERCEL_GIT_COMMIT_SHA: '', RAILWAY_GIT_COMMIT_SHA: 'b'.repeat(40) },
])(
  'an archive without Git passes route and asset checks independently of host metadata %j',
  (metadata) => {
    const root = archive();
    writeFileSync(join(root, 'dist/_astro/game.js'), 'console.log("gameplay");');
    const result = checkArchive(root, metadata);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('3 static routes, 1 modules');
  }
);
