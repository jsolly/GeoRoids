import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkBuiltClient } from './check-built-client.mjs';

const sha = 'a'.repeat(40);
function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), 'georoids-built-routes-'));
  const write = (path, body) => writeFileSync(join(root, path), body);
  for (const directory of ['dist/debug', 'dist/wiki', 'dist/_astro', 'content/wiki']) {
    mkdirSync(join(root, directory), { recursive: true });
  }
  const game =
    '<!doctype html><html><head><title>GeoRoids</title><link rel="canonical" href="https://www.georoids.com/"></head><body><canvas id="gameCanvas"></canvas><script type="module" src="/_astro/page.js"></script></body></html>';
  write('dist/index.html', game);
  write('dist/debug/index.html', game);
  write(
    'dist/wiki/index.html',
    '<!doctype html><html><head><title>Wiki</title><link rel="canonical" href="https://www.georoids.com/wiki/"></head><body><main id="content"><h1>Overview</h1><section id="ships">Ships</section><section id="controls" data-panel="article"><h2>Controls</h2>Fly the ship.</section></main></body></html>'
  );
  write('content/wiki/controls.md', '# Controls');
  write('dist/release.json', JSON.stringify({ releaseSha: sha }));
  write(
    'dist/client-assets.json',
    JSON.stringify({
      releaseSha: sha,
      gameplay: ['_astro/engine.js'],
      modules: { '_astro/page.js': ['_astro/engine.js'], '_astro/engine.js': [] },
    })
  );
  write('dist/_astro/page.js', 'import("./engine.js")');
  write('dist/_astro/engine.js', `const release = "${sha}";`);
  try {
    run({ root, write });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('the build publishes distinct static routes with readable Wiki articles and reachable gameplay', () => {
  fixture(({ root }) =>
    assert.deepEqual(checkBuiltClient(root, sha), { releaseSha: sha, routes: 3, modules: 2 })
  );
});
for (const [name, mutate, error] of [
  ['missing debug route', ({ root }) => rmSync(join(root, 'dist/debug/index.html')), /ENOENT/u],
  [
    'missing editorial fallback',
    ({ write }) => write('content/wiki/new-entry.md', '# New entry'),
    /Static Wiki article is missing: new-entry/u,
  ],
  [
    'duplicate article anchors',
    ({ root, write }) =>
      write(
        'dist/wiki/index.html',
        readFileSync(join(root, 'dist/wiki/index.html'), 'utf8').replace(
          '</main>',
          '<p id="controls">Duplicate</p></main>'
        )
      ),
    /Duplicate anchors/u,
  ],
  ['missing gameplay chunk', ({ root }) => rmSync(join(root, 'dist/_astro/engine.js')), /ENOENT/u],
  [
    'stale release',
    ({ write }) => write('dist/release.json', JSON.stringify({ releaseSha: 'b'.repeat(40) })),
    /Built release identity differs/u,
  ],
  [
    'stale game bundle',
    ({ write }) => write('dist/_astro/engine.js', 'const release = "old";'),
    /lack the release identity/u,
  ],
  [
    'unreachable gameplay',
    ({ write }) =>
      write(
        'dist/client-assets.json',
        JSON.stringify({
          releaseSha: sha,
          gameplay: ['_astro/engine.js'],
          modules: { '_astro/page.js': [], '_astro/engine.js': [] },
        })
      ),
    /Gameplay bundle is unreachable/u,
  ],
]) {
  test(`a build with ${name} fails publication validation`, () =>
    fixture((state) => {
      mutate(state);
      assert.throws(() => checkBuiltClient(state.root, sha), error);
    }));
}
