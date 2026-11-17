/* @vitest-environment node */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { buildVercelOutput } from '../../../scripts/build-vercel-output.mts';
import { clientAssetGraph, clientDocumentAssets } from '../../../scripts/client-asset-graph.ts';

const roots: string[] = [];
const namespace = '_vercel/immutable/0123456789abcdef01234567';
const game = 'import("./audio.new.js");';
const audio = 'export const sound = true;';

function record(value: unknown): Record<string, unknown> {
  assert(typeof value === 'object' && value !== null && !Array.isArray(value));
  return Object.fromEntries(Object.entries(value));
}

function matches(route: Record<string, unknown>, pathname: string): boolean {
  const source = route['src'];
  return typeof source === 'string' && source.length > 0 && new RegExp(source, 'u').test(pathname);
}

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'georoids-retention-'));
  roots.push(root);
  await mkdir(join(root, 'dist', namespace), { recursive: true });
  await writeFile(join(root, 'dist', namespace, 'game.new.js'), game);
  await writeFile(join(root, 'dist', namespace, 'audio.new.js'), audio);
  await writeFile(join(root, 'dist/index.html'), '<!doctype html><title>Current flight</title>');
  return root;
}

test('emitted client bytes have exact native and public SHA256 inventories and current document routes', async () => {
  const root = await fixture();
  expect(await buildVercelOutput({ root })).toEqual({ immutableFiles: 2 });
  const output = join(root, '.vercel/output');
  const manifest = await readFile(join(output, 'immutable.json'), 'utf8');
  expect(JSON.parse(manifest)).toEqual({
    version: 1,
    hashes: {
      [`/${namespace}/game.new.js`]:
        '8a64ee7578da900d9c7063730239ff56727f7d6aabfabf366151315637286d50',
      [`/${namespace}/audio.new.js`]:
        'b0f0e5b7a7cc7cc8ad8b7156ebac5b0203bd2ee28bb1dbe49686867a13d2c9fb',
    },
  });
  expect(await readFile(join(output, 'static/immutable-assets.json'), 'utf8')).toBe(manifest);
  for (const [file, bytes] of [
    ['game.new.js', game],
    ['audio.new.js', audio],
  ]) {
    assert(file !== undefined && bytes !== undefined);
    expect(await readFile(join(output, 'static', namespace, file), 'utf8')).toBe(bytes);
  }
  const config = record(JSON.parse(await readFile(join(output, 'config.json'), 'utf8')));
  assert(Array.isArray(config['routes']));
  const routes = config['routes'].map((value: unknown) => record(value));
  expect(routes).toContainEqual({ src: '^/(debug|wiki)/?$', dest: '/$1/index.html' });
  for (const name of ['release', 'client-assets', 'immutable-assets']) {
    const route = routes.find((candidate) => matches(candidate, `/${name}.json`));
    assert(route);
    expect(record(route['headers'])['Cache-Control']).toBe('no-store');
    expect(route['continue']).toBe(true);
  }
  for (const path of ['/debug', '/debug/', '/debug/?incident=test', '/debug/index.html']) {
    const route = routes.find((candidate) =>
      matches(candidate, new URL(path, 'https://www.georoids.com').pathname)
    );
    assert(route);
    expect(record(route['headers'])['X-Robots-Tag']).toBe('noindex, nofollow');
    expect(route['continue']).toBe(true);
  }
  expect(
    routes.some(
      (route) => matches(route, '/wiki/') && record(route['headers'] ?? {})['X-Robots-Tag']
    )
  ).toBe(false);
  expect(await readFile(join(output, 'static/index.html'), 'utf8')).toContain('Current flight');
});

test.each(['production', 'preview', 'local'])(
  '%s output hashes current build bytes without network access',
  async (environment) => {
    const root = await fixture();
    vi.stubEnv('VERCEL', environment === 'local' ? '' : '1');
    vi.stubEnv('VERCEL_ENV', environment);
    const fetchAsset = vi.fn(() => {
      throw new Error('Builds must not fetch previous deployments');
    });
    vi.stubGlobal('fetch', fetchAsset);
    expect(await buildVercelOutput({ root })).toEqual({ immutableFiles: 2 });
    expect(fetchAsset).not.toHaveBeenCalled();
  }
);

test('a symlink cannot smuggle mutable or external bytes into the immutable manifest', async () => {
  const root = await fixture();
  await writeFile(join(root, 'outside.js'), 'external');
  await symlink(join(root, 'outside.js'), join(root, 'dist', namespace, 'escape.js'));
  await expect(buildVercelOutput({ root })).rejects.toThrow(
    'Immutable output must not contain symlinks'
  );
});

test('the emitted namespace supports prehydration entries and transitive lazy imports but rejects traversal', () => {
  const entry = `${namespace}/game.new.js`;
  const lazy = `${namespace}/audio.new.js`;
  const document = clientDocumentAssets(
    `<astro-island component-url="/${entry}" renderer-url="/${entry}"></astro-island>`
  );
  expect(
    clientAssetGraph(
      { gameplay: [lazy], modules: { [entry]: [lazy], [lazy]: [] } },
      document.modules
    )
  ).toEqual([lazy, entry]);
  expect(() =>
    clientAssetGraph({ gameplay: [lazy], modules: { [entry]: ['../secret.js'] } }, [entry])
  ).toThrow('not first-party');
});
