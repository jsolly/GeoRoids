/* @vitest-environment node */
import assert from 'node:assert/strict';
import { expect, test, vi } from 'vitest';
import type { FetchAsset } from '../../../scripts/build-vercel-output.mts';
import { contentHash } from '../../../scripts/build-vercel-output.mts';
import {
  captureRetainedAssets,
  verifyRetainedAssets,
} from '../../../scripts/verify-retained-assets.mts';

const prefix = '/_vercel/immutable/0123456789abcdef01234567/';
const oldPath = `${prefix}game.old.js`;
const newPath = `${prefix}game.new.js`;
const oldBody = 'export const game = "old";';
const snapshot = {
  version: 1,
  origin: 'https://www.georoids.com',
  capturedAt: '2026-10-15T15:00:00.000Z',
  assets: [{ path: oldPath, bytes: Buffer.byteLength(oldBody), sha256: contentHash(oldBody) }],
};

function transport({
  retained = oldBody,
  emitted = [newPath],
  changed = false,
}: {
  retained?: string;
  emitted?: string[];
  changed?: boolean;
} = {}) {
  const changeInventory = Boolean(changed);
  let inventoryReads = 0;
  const fetchAsset = vi.fn<FetchAsset>((url) => {
    const path = new URL(url).pathname;
    if (path === '/immutable-assets.json') {
      inventoryReads++;
      const paths = changeInventory && inventoryReads > 1 ? [oldPath, newPath] : emitted;
      return Response.json({
        version: 1,
        hashes: Object.fromEntries(paths.map((name) => [name, 'a'.repeat(64)])),
      });
    }
    if (path === '/client-assets.json') {
      return Response.json({ gameplay: [oldPath.slice(1)], modules: { [oldPath.slice(1)]: [] } });
    }
    if (['/', '/debug/', '/wiki/'].includes(path)) {
      return new Response(`<script type="module" src="${oldPath}"></script>`, {
        headers: { 'content-type': 'text/html' },
      });
    }
    if (path === oldPath) {
      return new Response(retained, { headers: { 'content-type': 'text/javascript' } });
    }
    return new Response(null, { status: 404 });
  });
  return fetchAsset;
}

test('a later output omits the old game while its original uncached URL still returns identical bytes', async () => {
  const fetchAsset = transport();
  expect(await verifyRetainedAssets(snapshot, fetchAsset)).toMatchObject({
    checkedAssets: 1,
    omitted: [oldPath],
  });
  const assetRequest = fetchAsset.mock.calls.find(([url]) => new URL(url).pathname === oldPath);
  assert(assetRequest);
  expect(assetRequest[1]).toMatchObject({
    cache: 'no-store',
    redirect: 'error',
    headers: { 'Cache-Control': 'no-cache' },
  });
});

test.each([
  { label: 'missing', metadata: undefined },
  { label: 'opaque', metadata: { legacyClock: [4, 2] } },
])(
  '$label capture metadata passes through without tightening the version-1 receipt',
  async ({ metadata }) => {
    const legacy = { version: snapshot.version, origin: snapshot.origin, assets: snapshot.assets };
    const input = metadata === undefined ? legacy : { ...legacy, capturedAt: metadata };
    const receipt = await verifyRetainedAssets(input, transport());
    expect(Object.hasOwn(receipt, 'capturedAt')).toBe(true);
    expect(receipt.capturedAt).toBe(metadata);
    const serialized: unknown = JSON.parse(JSON.stringify(receipt));
    expect(serialized).toEqual({
      version: 1,
      origin: snapshot.origin,
      ...(metadata === undefined ? {} : { capturedAt: metadata }),
      verifiedAt: expect.any(String),
      checkedAssets: 1,
      omitted: [oldPath],
    });
  }
);

test('an unreferenced old file still present in deployment output cannot falsely prove retention', async () => {
  await expect(
    verifyRetainedAssets(snapshot, transport({ emitted: [oldPath, newPath] }))
  ).rejects.toThrow('cross-deployment retention is unproven');
});

test('an empty emitted inventory cannot falsely claim every old file was omitted', async () => {
  await expect(verifyRetainedAssets(snapshot, transport({ emitted: [] }))).rejects.toThrow(
    'Invalid current immutable inventory size'
  );
});

test('a deployment changing during verification cannot combine omission with another output', async () => {
  await expect(verifyRetainedAssets(snapshot, transport({ changed: true }))).rejects.toThrow(
    'Deployment changed during verification'
  );
});

test('an old URL returning different same-sized bytes fails checksum verification', async () => {
  await expect(
    verifyRetainedAssets(snapshot, transport({ retained: oldBody.replace('old', 'bad') }))
  ).rejects.toThrow('Retained checksum mismatch');
});

test('capture records actual current bytes and rechecks a stable document/module inventory', async () => {
  const fetchAsset = transport();
  expect(await captureRetainedAssets(fetchAsset)).toMatchObject({
    version: 1,
    origin: snapshot.origin,
    assets: snapshot.assets,
  });
  expect(
    fetchAsset.mock.calls.filter(([url]) => new URL(url).pathname === '/client-assets.json')
  ).toHaveLength(2);
});

test('a captured path cannot point at another origin or traverse out of the immutable namespace', async () => {
  const fetchAsset = transport();
  const invalid = {
    ...snapshot,
    assets: [{ ...snapshot.assets[0], path: '//example.org/secret.js' }],
  };
  await expect(verifyRetainedAssets(invalid, fetchAsset)).rejects.toThrow();
  expect(fetchAsset).not.toHaveBeenCalled();
});
