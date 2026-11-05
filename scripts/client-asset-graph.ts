import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

function assetPath(value: unknown, javascript = false): string {
  assert(
    typeof value === 'string' &&
      /^(?:assets|_astro|_vercel\/immutable\/[a-f0-9]{24})\/[a-zA-Z0-9_.-]+\.(?:js|css)$/u.test(
        value
      ) &&
      (!javascript || value.endsWith('.js')),
    'Client bundle asset is not first-party'
  );
  return value;
}

/** Validate the emitted module graph, then prove gameplay is reachable from the page. */
export function clientAssetGraph(manifest: unknown, entries: readonly string[]): string[] {
  assert(
    manifest !== null &&
      typeof manifest === 'object' &&
      'gameplay' in manifest &&
      'modules' in manifest &&
      Array.isArray(manifest.gameplay) &&
      manifest.gameplay.length > 0 &&
      manifest.modules !== null &&
      typeof manifest.modules === 'object' &&
      !Array.isArray(manifest.modules),
    'Published client asset manifest is malformed'
  );
  const graph = new Map<string, string[]>();
  for (const [module, imports] of Object.entries(manifest.modules)) {
    assetPath(module, true);
    assert(Array.isArray(imports), 'Client module imports are malformed');
    graph.set(
      module,
      imports.map((path) => assetPath(path, true))
    );
  }
  for (const imports of graph.values()) {
    assert(
      imports.every((path) => graph.has(path)),
      'Client module graph is incomplete'
    );
  }
  const gameplay = manifest.gameplay.map((path) => assetPath(path, true));
  assert(new Set(gameplay).size === gameplay.length, 'Duplicate gameplay attribution');
  const pending = entries.map((path) => assetPath(path, true));
  assert(pending.length > 0, 'Client module entry is missing');
  const reachable = new Set<string>();
  while (pending.length > 0) {
    const path = pending.pop();
    assert(path !== undefined);
    if (reachable.has(path)) {
      continue;
    }
    const imports = graph.get(path);
    assert(imports, 'Client entry is absent from the module graph');
    reachable.add(path);
    pending.push(...imports);
  }
  assert(
    gameplay.every((path) => reachable.has(path)),
    'Gameplay bundle is unreachable'
  );
  return [...reachable].sort();
}

/** Astro hydration loads island entries from attributes, alongside ordinary scripts. */
export function clientDocumentAssets(html: string): { modules: string[]; assets: string[] } {
  const require = createRequire(import.meta.url);
  const { JSDOM }: typeof import('jsdom') = require('jsdom');
  const dom = new JSDOM(html);
  try {
    const elements = (selector: string) =>
      [...dom.window.document.querySelectorAll(selector)].filter(
        (element) => !element.closest('noscript')
      );
    const scripts = elements('script')
      .filter((element) => element.getAttribute('type') === 'module')
      .flatMap((element) => element.getAttribute('src') || []);
    const islands = elements('astro-island').flatMap((element) => {
      const component = element.getAttribute('component-url');
      const renderer = element.getAttribute('renderer-url');
      assert(component && renderer, 'Client island entry is missing');
      return [component, renderer];
    });
    const links = elements('link')
      .filter((element) =>
        ['modulepreload', 'stylesheet'].includes(element.getAttribute('rel') ?? '')
      )
      .map((element) => element.getAttribute('href'));
    const modules = [...new Set([...scripts, ...islands])];
    assert(modules.length > 0, 'Client module entry is missing');
    const path = (value: unknown, javascript = false) => {
      assert(
        typeof value === 'string' && value.startsWith('/') && !value.startsWith('//'),
        'Client bundle asset is not first-party'
      );
      return assetPath(value.slice(1), javascript);
    };
    return {
      modules: modules.map((value) => path(value, true)),
      assets: [...new Set([...modules, ...links])].map((value) => path(value)),
    };
  } finally {
    dom.window.close();
  }
}
