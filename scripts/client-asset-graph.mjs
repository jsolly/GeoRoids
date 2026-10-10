import assert from 'node:assert/strict';

function assetPath(value, javascript = false) {
  assert(
    typeof value === 'string' &&
      /^(?:assets|_astro)\/[a-zA-Z0-9_.-]+\.(?:js|css)$/u.test(value) &&
      (!javascript || value.endsWith('.js')),
    'Client bundle asset is not first-party'
  );
  return value;
}

/** Validate the emitted module graph, then prove gameplay is reachable from the page. */
export function clientAssetGraph(manifest, entries) {
  assert(
    manifest &&
      Array.isArray(manifest.gameplay) &&
      manifest.gameplay.length > 0 &&
      manifest.modules &&
      typeof manifest.modules === 'object' &&
      !Array.isArray(manifest.modules),
    'Published client asset manifest is malformed'
  );
  const graph = new Map();
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
  const reachable = new Set();
  while (pending.length > 0) {
    const path = pending.pop();
    if (reachable.has(path)) {
      continue;
    }
    assert(graph.has(path), 'Client entry is absent from the module graph');
    reachable.add(path);
    pending.push(...graph.get(path));
  }
  assert(
    gameplay.every((path) => reachable.has(path)),
    'Gameplay bundle is unreachable'
  );
  return [...reachable].sort();
}

function attribute(tag, name) {
  return new RegExp(`(?:^|\\s)${name}\\s*=\\s*["']([^"']+)["']`, 'iu').exec(tag)?.[1];
}

/** Astro hydration loads island entries from attributes, alongside ordinary scripts. */
export function clientDocumentAssets(html) {
  const scripts = [...html.matchAll(/<script\b[^>]*>/giu)]
    .filter(([tag]) => attribute(tag, 'type') === 'module')
    .flatMap(([tag]) => attribute(tag, 'src') ?? []);
  const islands = [...html.matchAll(/<astro-island\b[^>]*>/giu)].flatMap(([tag]) => {
    const component = attribute(tag, 'component-url');
    const renderer = attribute(tag, 'renderer-url');
    assert(component && renderer, 'Client island entry is missing');
    return [component, renderer];
  });
  const links = [...html.matchAll(/<link\b[^>]*>/giu)]
    .filter(([tag]) => ['modulepreload', 'stylesheet'].includes(attribute(tag, 'rel')))
    .map(([tag]) => attribute(tag, 'href'));
  const modules = [...new Set([...scripts, ...islands])];
  assert(modules.length > 0, 'Client module entry is missing');
  const path = (value, javascript = false) => {
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
}
