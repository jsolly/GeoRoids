import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { clientAssetGraph } from './client-asset-graph.mjs';

export function checkBuiltClient(root = process.cwd()) {
  const read = (path) => readFileSync(join(root, 'dist', path), 'utf8');
  const manifest = JSON.parse(read('client-assets.json'));
  const gameDocuments = [];
  for (const path of ['index.html', 'debug/index.html', 'wiki/index.html']) {
    const html = read(path);
    assert.match(html, /<!doctype html>/iu, `Missing static document: ${path}`);
    const dom = new JSDOM(html);
    try {
      const document = dom.window.document;
      assert(document.title.trim(), `Missing title: ${path}`);
      assert(document.querySelector('link[rel="canonical"]'), `Missing canonical URL: ${path}`);
      const ids = [...document.querySelectorAll('[id]')].map((element) => element.id);
      assert.equal(new Set(ids).size, ids.length, `Duplicate anchors: ${path}`);
      if (path === 'wiki/index.html') {
        assert(document.querySelector('#content h1'), 'The static Wiki overview is missing');
        assert(document.querySelector('#ships'), 'The static ship overview is missing');
        for (const file of readdirSync(join(root, 'content/wiki')).filter((name) =>
          name.endsWith('.md')
        )) {
          const id = basename(file, '.md');
          const panel = [...document.querySelectorAll('[data-panel="article"]')].find(
            (element) => element.id === id
          );
          assert(panel?.matches('[data-panel="article"]'), `Static Wiki article is missing: ${id}`);
          assert(panel.querySelector('h1,h2'), `Static Wiki article heading is missing: ${id}`);
          assert(panel.textContent.trim(), `Static Wiki article is empty: ${id}`);
        }
        assert(!document.querySelector('#gameCanvas'), 'The Wiki contains a game host');
      } else {
        assert(document.querySelector('canvas#gameCanvas'), `Missing game canvas: ${path}`);
        const entries = [...document.querySelectorAll('script[type="module"][src]')].map(
          (element) => {
            const source = element.getAttribute('src');
            assert(
              source.startsWith('/') && !source.startsWith('//'),
              'Game module must be first-party'
            );
            return source.slice(1);
          }
        );
        gameDocuments.push(clientAssetGraph(manifest, entries));
      }
    } finally {
      dom.window.close();
    }
  }
  assert.deepEqual(gameDocuments[0], gameDocuments[1], 'Debug and game entry graphs differ');
  for (const path of Object.keys(manifest.modules)) {
    assert(read(path).length > 0, `Emitted module is empty: ${path}`);
  }
  return { routes: 3, modules: Object.keys(manifest.modules).length };
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const result = checkBuiltClient();
  process.stdout.write(
    `Built client verified: ${result.routes} static routes, ${result.modules} modules\n`
  );
}
