import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const immutablePrefix = '/_vercel/immutable/';
const canonicalOrigin = 'https://www.georoids.com';
const migrationOrigin = 'https://georoids-lz58dersj-jsollys-projects.vercel.app';

export interface AssetPin {
  path: string;
  bytes: number;
  sha256: string;
}

export type FetchAsset = (url: string, init?: RequestInit) => Response | Promise<Response>;

interface LegacyInventory {
  origin: string;
  assets: AssetPin[];
}

interface OutputRoute {
  src?: string;
  headers?: Record<string, string>;
  continue?: boolean;
  dest?: string;
  handle?: 'filesystem';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function contentHash(bytes: string | NodeJS.ArrayBufferView): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function validateInventory(inventory: unknown): asserts inventory is LegacyInventory {
  assert(isRecord(inventory), 'Malformed legacy inventory');
  assert.equal(inventory['origin'], migrationOrigin, 'Unexpected legacy asset origin');
  assert(Array.isArray(inventory['assets']) && inventory['assets'].length > 0);
  assert(inventory['assets'].length <= 100, 'Legacy inventory is too large');
  const paths = new Set<string>();
  for (const value of inventory['assets']) {
    const asset: unknown = value;
    assert(isRecord(asset), 'Malformed legacy asset');
    assert(typeof asset['path'] === 'string');
    assert(typeof asset['sha256'] === 'string');
    assert(typeof asset['bytes'] === 'number');
    assert.match(
      asset['path'],
      /^_astro\/[a-zA-Z0-9_-][a-zA-Z0-9_.-]*\.[a-zA-Z0-9_-]+\.(?:js|css)$/u
    );
    assert.match(asset['sha256'], /^[a-f0-9]{64}$/u);
    assert(
      Number.isSafeInteger(asset['bytes']) && asset['bytes'] > 0 && asset['bytes'] <= 16_777_216
    );
    assert(!paths.has(asset['path']), 'Duplicate legacy asset');
    paths.add(asset['path']);
  }
}

/** Only a missing registry entry permits bootstrap from the pinned deployment. */
export async function legacyAssetBytes(
  asset: AssetPin,
  fetchAsset: FetchAsset = fetch
): Promise<{ target: string; bytes: Buffer | null }> {
  const target = `${immutablePrefix}legacy/${asset.path.slice('_astro/'.length)}`;
  async function download(url: string, allowMissing: boolean): Promise<Buffer | null> {
    const response = await fetchAsset(url, {
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(20_000),
    });
    if (allowMissing && response.status === 404) {
      await response.body?.cancel();
      return null;
    }
    assert.equal(response.status, 200, `Legacy asset unavailable: ${url}`);
    assert(response.body, `Legacy asset body missing: ${url}`);
    const parts: Uint8Array[] = [];
    let size = 0;
    for await (const part of response.body) {
      size += part.length;
      assert(size <= asset.bytes, `Legacy asset exceeds pinned size: ${url}`);
      parts.push(part);
    }
    const bytes = Buffer.concat(parts);
    assert.equal(bytes.length, asset.bytes, `Legacy asset size changed: ${url}`);
    assert.equal(contentHash(bytes), asset.sha256, `Legacy asset checksum changed: ${url}`);
    return bytes;
  }
  const registered = await download(`${canonicalOrigin}${target}`, true);
  return {
    target,
    // Registered bytes need no copying: the provider serves them across deployments.
    bytes: registered === null ? await download(`${migrationOrigin}/${asset.path}`, false) : null,
  };
}

/** Emit the provider's shared immutable registry, preserving ordinary local dist. */
interface BuildOutputOptions {
  root?: string;
  production?: boolean;
  fetchAsset?: FetchAsset;
}

export async function buildVercelOutput({
  root = process.cwd(),
  production = process.env['VERCEL'] === '1' && process.env['VERCEL_ENV'] === 'production',
  fetchAsset = fetch,
}: BuildOutputOptions = {}): Promise<{ immutableFiles: number; legacyAliases: number }> {
  const productionBuild = Boolean(production);
  const inventory: unknown = JSON.parse(
    await readFile(join(root, 'scripts/legacy-client-assets.json'), 'utf8')
  );
  validateInventory(inventory);
  const output = join(root, '.vercel/output');
  await rm(output, { recursive: true, force: true });
  const staticRoot = join(output, 'static');
  await cp(join(root, 'dist'), staticRoot, { recursive: true, errorOnExist: true });
  const hashes: Record<string, string> = {};
  async function walk(directory: string, prefix: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      assert(!entry.isSymbolicLink(), 'Immutable output must not contain symlinks');
      const path = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(join(directory, entry.name), path);
      } else {
        assert(entry.isFile(), 'Immutable output is not a file');
        assert.match(path, /^\/_vercel\/immutable\/[a-f0-9]{24}\/[a-zA-Z0-9_.-]+\.(?:js|css)$/u);
        hashes[path] = contentHash(await readFile(join(directory, entry.name)));
      }
    }
  }
  await walk(join(staticRoot, '_vercel/immutable'), '/_vercel/immutable');
  assert(Object.keys(hashes).length > 0, 'Immutable client output is empty');
  const routes: OutputRoute[] = [
    {
      src: '^/(?:release|client-assets|immutable-assets)\\.json$',
      headers: { 'Cache-Control': 'no-store' },
      continue: true,
    },
    {
      src: '^/debug(?:/.*)?$',
      headers: { 'X-Robots-Tag': 'noindex, nofollow' },
      continue: true,
    },
    {
      src: '^/(?:debug/?|wiki/?)?$',
      headers: {
        Link: '<https://context7.com/api/v2/ask?siteKey=ask_10533b7684feb0762503b0e7>; rel="search"; type="text/plain"; title="Search georoids.com"',
      },
      continue: true,
    },
  ];
  for (const asset of inventory['assets']) {
    const target = `${immutablePrefix}legacy/${asset.path.slice('_astro/'.length)}`;
    routes.push({ src: `^/${asset.path.replaceAll('.', '\\.')}$`, dest: target });
    if (productionBuild) {
      const migrated = await legacyAssetBytes(asset, fetchAsset);
      if (migrated.bytes !== null) {
        const destination = join(staticRoot, migrated.target.slice(1));
        await mkdir(dirname(destination), { recursive: true });
        await writeFile(destination, migrated.bytes);
        hashes[target] = asset.sha256;
      }
    }
  }
  routes.push(
    { src: '^/$', dest: '/index.html' },
    { src: '^/(debug|wiki)/?$', dest: '/$1/index.html' },
    { handle: 'filesystem' }
  );
  await writeFile(
    join(output, 'config.json'),
    `${JSON.stringify({ version: 3, routes }, null, 2)}\n`
  );
  const immutableManifest = `${JSON.stringify({ version: 1, hashes }, null, 2)}\n`;
  await writeFile(join(output, 'immutable.json'), immutableManifest);
  // This complete emitted inventory lets production verification prove omission,
  // rather than confusing an unreferenced file with an absent file.
  await writeFile(join(staticRoot, 'immutable-assets.json'), immutableManifest);
  return { immutableFiles: Object.keys(hashes).length, legacyAliases: inventory['assets'].length };
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const result = await buildVercelOutput();
  process.stdout.write(
    `Vercel output: ${result.immutableFiles} immutable files, ${result.legacyAliases} legacy aliases\n`
  );
}
