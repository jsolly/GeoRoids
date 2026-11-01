/* @vitest-environment node */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import {
  buildVercelOutput,
  contentHash,
  legacyAssetBytes,
} from '../../../scripts/build-vercel-output.mjs';
import { clientAssetGraph, clientDocumentAssets } from '../../../scripts/client-asset-graph.ts';

const roots = [];
const body = 'export const audio = true;';
const asset = {
  path: '_astro/howler.old.js',
  bytes: Buffer.byteLength(body),
  sha256: contentHash(body),
};
const origin = 'https://georoids-lz58dersj-jsollys-projects.vercel.app';
const namespace = '_vercel/immutable/0123456789abcdef01234567';

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'georoids-retention-'));
  roots.push(root);
  await mkdir(join(root, 'scripts'), { recursive: true });
  await mkdir(join(root, 'dist', namespace), { recursive: true });
  await writeFile(
    join(root, 'scripts/legacy-client-assets.json'),
    JSON.stringify({ origin, assets: [asset] })
  );
  await writeFile(join(root, 'dist', namespace, 'game.new.js'), 'import("./audio.new.js");');
  await writeFile(join(root, 'dist', namespace, 'audio.new.js'), 'export const sound = true;');
  await writeFile(join(root, 'dist/index.html'), '<!doctype html><title>Current flight</title>');
  return root;
}

test('a production build seeds missing old audio bytes and emits exact aliases and current static routes', async () => {
  const root = await fixture();
  const fetchAsset = vi
    .fn()
    .mockResolvedValueOnce(new Response(null, { status: 404 }))
    .mockResolvedValueOnce(new Response(body));
  expect(await buildVercelOutput({ root, production: true, fetchAsset })).toEqual({
    immutableFiles: 3,
    legacyAliases: 1,
  });
  expect(fetchAsset.mock.calls.map(([url]) => url)).toEqual([
    'https://www.georoids.com/_vercel/immutable/legacy/howler.old.js',
    `${origin}/${asset.path}`,
  ]);
  const output = join(root, '.vercel/output');
  const migrated = await readFile(join(output, 'static/_vercel/immutable/legacy/howler.old.js'));
  expect(contentHash(migrated)).toBe(asset.sha256);
  const manifest = JSON.parse(await readFile(join(output, 'immutable.json'), 'utf8'));
  expect(await readFile(join(output, 'static/immutable-assets.json'), 'utf8')).toBe(
    await readFile(join(output, 'immutable.json'), 'utf8')
  );
  expect(manifest.hashes['/_vercel/immutable/legacy/howler.old.js']).toBe(asset.sha256);
  const config = JSON.parse(await readFile(join(output, 'config.json'), 'utf8'));
  const alias = config.routes.find((route) => route.dest?.includes('/legacy/'));
  expect(new RegExp(alias.src, 'u').test('/_astro/howler.old.js')).toBe(true);
  expect(new RegExp(alias.src, 'u').test('/_astro/howlerXoldXjs')).toBe(false);
  expect(alias.dest).toBe('/_vercel/immutable/legacy/howler.old.js');
  expect(config.routes).toContainEqual({ src: '^/(debug|wiki)/?$', dest: '/$1/index.html' });
  expect(config.routes[0].headers['Cache-Control']).toBe('no-store');
  for (const path of ['/debug', '/debug/', '/debug/?incident=test', '/debug/index.html']) {
    const pathname = new URL(path, 'https://www.georoids.com').pathname;
    const matched = config.routes.find(
      (route) => route.src && new RegExp(route.src, 'u').test(pathname)
    );
    expect(matched?.headers?.['X-Robots-Tag']).toBe('noindex, nofollow');
    expect(matched?.continue).toBe(true);
  }
  expect(
    config.routes.some(
      (route) => route.headers?.['X-Robots-Tag'] && new RegExp(route.src, 'u').test('/wiki/')
    )
  ).toBe(false);
  expect(await readFile(join(output, 'static/index.html'), 'utf8')).toContain('Current flight');
});

test('later builds omit registered legacy bytes and never depend on the prior deployment', async () => {
  const root = await fixture();
  const fetchAsset = vi.fn().mockResolvedValue(new Response(body));
  expect(await buildVercelOutput({ root, production: true, fetchAsset })).toEqual({
    immutableFiles: 2,
    legacyAliases: 1,
  });
  expect(fetchAsset).toHaveBeenCalledTimes(1);
  await expect(
    readFile(join(root, '.vercel/output/static/_vercel/immutable/legacy/howler.old.js'))
  ).rejects.toThrow();
  expect(
    JSON.parse(await readFile(join(root, '.vercel/output/immutable.json'), 'utf8')).hashes[
      '/_vercel/immutable/legacy/howler.old.js'
    ]
  ).toBeUndefined();
});

test.each([403, 500])('registry status %i fails closed without source fallback', async (status) => {
  const fetchAsset = vi.fn().mockResolvedValue(new Response(null, { status }));
  await expect(legacyAssetBytes(asset, fetchAsset)).rejects.toThrow('Legacy asset unavailable');
  expect(fetchAsset).toHaveBeenCalledTimes(1);
});

test.each(['export const audio = false;', body.replace('true', 'evil')])(
  'corrupt legacy bytes reject instead of publishing a broken alias: %s',
  async (corrupt) => {
    await expect(
      legacyAssetBytes(asset, vi.fn().mockResolvedValue(new Response(corrupt)))
    ).rejects.toThrow(/Legacy asset (exceeds pinned size|checksum changed)/u);
  }
);

test('local and CI builds emit native artifacts without contacting production', async () => {
  const root = await fixture();
  const fetchAsset = vi.fn();
  await buildVercelOutput({ root, production: false, fetchAsset });
  expect(fetchAsset).not.toHaveBeenCalled();
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
