import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import type { AssetPin, FetchAsset } from './build-vercel-output.mts';
import { clientAssetGraph, clientDocumentAssets } from './client-asset-graph.ts';

const origin = 'https://www.georoids.com';
const assetPattern = /^\/_vercel\/immutable\/[a-f0-9]{24}\/[a-zA-Z0-9_.-]+\.(?:js|css)$/u;
const hash = (bytes: string | NodeJS.ArrayBufferView): string =>
  createHash('sha256').update(bytes).digest('hex');

async function download(path: string, fetchAsset: FetchAsset): Promise<Buffer> {
  const response = await fetchAsset(`${origin}${path}`, {
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.timeout(20_000),
    headers: { 'Cache-Control': 'no-cache' },
  });
  assert.equal(response.status, 200, `Asset verification HTTP failure: ${path}`);
  const mime =
    (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  assert(
    path.endsWith('.js')
      ? [
          'application/javascript',
          'text/javascript',
          'application/ecmascript',
          'text/ecmascript',
        ].includes(mime)
      : path.endsWith('.css')
        ? mime === 'text/css'
        : path.endsWith('.json')
          ? mime === 'application/json'
          : mime === 'text/html',
    `Unexpected asset content type: ${path}`
  );
  assert(response.body, `Missing asset body: ${path}`);
  const parts: Uint8Array[] = [];
  let bytes = 0;
  for await (const part of response.body) {
    bytes += part.length;
    assert(bytes <= 16_777_216, `Asset is too large: ${path}`);
    parts.push(part);
  }
  assert(bytes > 0, `Empty asset: ${path}`);
  return Buffer.concat(parts);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function currentPaths(fetchAsset: FetchAsset): Promise<Set<string>> {
  const manifest: unknown = JSON.parse(
    (await download('/client-assets.json', fetchAsset)).toString()
  );
  assert(isRecord(manifest));
  assert(isRecord(manifest['modules']));
  const paths = new Set(Object.keys(manifest['modules']).map((path) => `/${path}`));
  for (const route of ['/', '/debug/', '/wiki/']) {
    const document = clientDocumentAssets((await download(route, fetchAsset)).toString());
    if (route !== '/wiki/') {
      clientAssetGraph(manifest, document.modules);
    }
    for (const path of document.assets) {
      paths.add(`/${path}`);
    }
  }
  assert(paths.size > 0 && paths.size <= 1000, 'Invalid current asset inventory size');
  for (const path of paths) {
    assert.match(path, assetPattern);
  }
  return paths;
}

interface RetainedSnapshot {
  version: 1;
  origin: string;
  capturedAt: string;
  assets: AssetPin[];
}

export async function captureRetainedAssets(
  fetchAsset: FetchAsset = fetch
): Promise<RetainedSnapshot> {
  const assets: AssetPin[] = [];
  const current = await currentPaths(fetchAsset);
  for (const path of current) {
    const bytes = await download(path, fetchAsset);
    assets.push({ path, bytes: bytes.length, sha256: hash(bytes) });
  }
  assert.deepEqual(
    [...(await currentPaths(fetchAsset))].sort(),
    [...current].sort(),
    'Deployment changed during capture'
  );
  return { version: 1, origin, capturedAt: new Date().toISOString(), assets };
}

// Version 1 only consumes asset pins; timestamp metadata is an opaque passthrough.
type VerifiableSnapshot = Omit<RetainedSnapshot, 'capturedAt'> & { capturedAt?: unknown };

function assertSnapshot(snapshot: unknown): asserts snapshot is VerifiableSnapshot {
  assert(isRecord(snapshot));
  assert.equal(snapshot['version'], 1);
  assert.equal(snapshot['origin'], origin);
  assert(
    Array.isArray(snapshot['assets']) &&
      snapshot['assets'].length > 0 &&
      snapshot['assets'].length <= 1000
  );
  const paths = new Set<string>();
  for (const value of snapshot['assets']) {
    const asset: unknown = value;
    assert(isRecord(asset));
    assert(typeof asset['path'] === 'string');
    assert(typeof asset['sha256'] === 'string');
    assert(typeof asset['bytes'] === 'number');
    assert.match(asset['path'], assetPattern);
    assert.match(asset['sha256'], /^[a-f0-9]{64}$/u);
    assert(
      Number.isSafeInteger(asset['bytes']) && asset['bytes'] > 0 && asset['bytes'] <= 16_777_216
    );
    assert(!paths.has(asset['path']), 'Duplicate retained asset');
    paths.add(asset['path']);
  }
}

export async function verifyRetainedAssets(
  snapshot: unknown,
  fetchAsset: FetchAsset = fetch
): Promise<{
  version: 1;
  origin: string;
  capturedAt: unknown;
  verifiedAt: string;
  checkedAssets: number;
  omitted: string[];
}> {
  assertSnapshot(snapshot);
  const paths = new Set(snapshot.assets.map((asset) => asset.path));
  const inventoryBytes = await download('/immutable-assets.json', fetchAsset);
  const inventory: unknown = JSON.parse(inventoryBytes.toString());
  assert(isRecord(inventory));
  assert.equal(inventory['version'], 1);
  assert(
    inventory['hashes'] &&
      typeof inventory['hashes'] === 'object' &&
      !Array.isArray(inventory['hashes']),
    'Malformed current immutable inventory'
  );
  const hashes = inventory['hashes'];
  assert(isRecord(hashes), 'Malformed current immutable inventory');
  const emitted = Object.entries(hashes);
  assert(emitted.length > 0 && emitted.length <= 1000, 'Invalid current immutable inventory size');
  for (const [path, digest] of emitted) {
    assert.match(
      path,
      /^\/_vercel\/immutable\/(?:[a-f0-9]{24}|legacy)\/[a-zA-Z0-9_.-]+\.(?:js|css)$/u
    );
    assert(typeof digest === 'string');
    assert.match(digest, /^[a-f0-9]{64}$/u);
  }
  const omitted = [...paths].filter((path) => !Object.hasOwn(hashes, path));
  assert(
    omitted.length > 0,
    'No captured asset was omitted by the current build; cross-deployment retention is unproven'
  );
  for (const asset of snapshot.assets) {
    const bytes = await download(asset.path, fetchAsset);
    assert.equal(bytes.length, asset.bytes, `Retained size mismatch: ${asset.path}`);
    assert.equal(hash(bytes), asset.sha256, `Retained checksum mismatch: ${asset.path}`);
  }
  assert.deepEqual(
    await download('/immutable-assets.json', fetchAsset),
    inventoryBytes,
    'Deployment changed during verification'
  );
  return {
    version: 1,
    origin,
    capturedAt: snapshot.capturedAt,
    verifiedAt: new Date().toISOString(),
    checkedAssets: paths.size,
    omitted,
  };
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const [mode, snapshotPath, receiptPath] = process.argv.slice(2);
  assert(
    snapshotPath && (mode === 'capture' || mode === 'verify'),
    'Usage: node scripts/verify-retained-assets.mjs capture SNAPSHOT | verify SNAPSHOT RECEIPT'
  );
  if (mode === 'capture') {
    const snapshot = await captureRetainedAssets();
    await writeFile(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, { flag: 'wx' });
    process.stdout.write(`Captured ${snapshot.assets.length} immutable assets\n`);
  } else {
    assert(receiptPath, 'Verification requires a receipt path');
    const receipt = await verifyRetainedAssets(JSON.parse(await readFile(snapshotPath, 'utf8')));
    await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' });
    process.stdout.write(
      `Verified ${receipt.checkedAssets} retained assets; ${receipt.omitted.length} omitted by the current build\n`
    );
  }
}
