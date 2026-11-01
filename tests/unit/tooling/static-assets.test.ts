// @vitest-environment node
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { afterEach, it as test, vi } from 'vitest';
import pinned from '../../../config/aws/static-assets/manifest.json' with { type: 'json' };
import template from '../../../config/aws/static-assets/template.json' with { type: 'json' };
import {
  type Asset,
  type AssetManifest,
  type AssetTransport,
  assertCoverage,
  assertUploadTarget,
  assetUrl,
  CACHE_CONTROL,
  createManifest,
  digest,
  type ObjectResponse,
  objectKey,
  parseManifest,
  TransientError,
  uploadAssets,
  verifyAssets,
} from '../../../scripts/assets/media';
import { publishedReferences } from '../../../scripts/assets/references';

const bytes = new TextEncoder().encode('audio-fixture');
const path = '/music/test.ogg';
const sha256 = digest(bytes);
const asset: Asset = {
  path,
  sha256,
  bytes: bytes.length,
  key: objectKey(path, sha256),
  contentType: 'audio/ogg',
};
const manifest: AssetManifest = { version: 1, assets: [asset] };
const object = (): ObjectResponse => ({
  bytes,
  contentType: 'audio/ogg',
  cacheControl: CACHE_CONTROL,
});
function fake(
  initial?: ObjectResponse
): AssetTransport & { writes: number; value: ObjectResponse | undefined } {
  const state = {
    writes: 0,
    value: initial,
    get() {
      return Promise.resolve(state.value);
    },
    put() {
      state.writes++;
      state.value = object();
      return Promise.resolve();
    },
  };
  return state;
}
afterEach(() => vi.useRealTimers());

test('immutable keys preserve public paths while malformed, duplicate and source-only entries fail', () => {
  assert.deepEqual(parseManifest(manifest), manifest);
  assert.equal(
    assetUrl('https://d123.cloudfront.net', asset),
    `https://d123.cloudfront.net/sha256/${sha256}/music/test.ogg`
  );
  for (const change of [
    { key: 'other' },
    { path: '/music/../private.ogg' },
    { path: '/src/private.png' },
    { contentType: 'text/html' },
    { bytes: 0 },
  ]) {
    assert.throws(() => parseManifest({ version: 1, assets: [{ ...asset, ...change }] }));
  }
  assert.throws(() => parseManifest({ version: 1, assets: [asset, asset] }));
  assert.throws(() => assetUrl('https://elsewhere.example', asset));
});

test('the committed manifest covers production media catalogs and every pinned source byte', async () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const current = parseManifest(pinned);
  const references = await publishedReferences(root);
  assertCoverage(current, references);
  assert.deepEqual(await createManifest(root, references), current);
  assert.ok(references.has('/music/menu-bed.ogg'));
  assert.ok(references.has('/music/menu-bed.mp3'));
  assert.ok(references.has('/wiki/media/movement.gif'));
  assert.ok(references.has('/wiki/media/movement.png'));
  assert.ok(references.has('/wiki/uploads/georoids-first-flight.png'));
});

test('reference completeness rejects missing and no-longer-published paths', () => {
  assertCoverage(manifest, new Set([path]));
  assert.throws(() => assertCoverage(manifest, new Set([path, '/sounds/new.m4a'])), /missing/u);
  assert.throws(() => assertCoverage(manifest, new Set()), /no longer published/u);
});

test('source preservation refuses missing bytes, hash changes and symlinked inputs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'georoids-assets-'));
  try {
    await mkdir(join(root, 'public/music'), { recursive: true });
    await assert.rejects(createManifest(root, new Set([path])));
    await writeFile(join(root, `public${path}`), bytes);
    assert.deepEqual(await createManifest(root, new Set([path])), manifest);
    await rm(join(root, `public${path}`));
    await writeFile(join(root, 'private.ogg'), bytes);
    await symlink(join(root, 'private.ogg'), join(root, `public${path}`));
    await assert.rejects(createManifest(root, new Set([path])), /Symlink/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('verified uploads resume without overwrites and corrupt existing objects stop publication', async () => {
  const transport = fake();
  await uploadAssets(manifest, () => Promise.resolve(bytes), transport);
  await uploadAssets(manifest, () => Promise.resolve(bytes), transport);
  assert.equal(transport.writes, 1);
  transport.value = { ...object(), bytes: new Uint8Array(bytes.length) };
  await assert.rejects(
    uploadAssets(manifest, () => Promise.resolve(bytes), transport),
    /bytes mismatch/u
  );
  assert.equal(transport.writes, 1);
  const untouched = fake();
  await assert.rejects(
    uploadAssets(manifest, () => Promise.resolve(new Uint8Array([2])), untouched),
    /Local bytes mismatch/u
  );
  assert.equal(untouched.writes, 0);
});

test('delivery verification rejects missing objects, wrong hashes and content/cache headers', async () => {
  await assert.rejects(verifyAssets(manifest, fake()), /Missing object/u);
  for (const change of [
    { bytes: new Uint8Array([1]) },
    { contentType: 'text/html' },
    { cacheControl: 'no-cache' },
  ]) {
    await assert.rejects(verifyAssets(manifest, fake({ ...object(), ...change })), /mismatch/u);
  }
});

test('fresh upload visibility retries survive a negative cache without issuing another PUT', async () => {
  vi.useFakeTimers();
  let reads = 0;
  let writes = 0;
  const transport: AssetTransport = {
    get() {
      return Promise.resolve(++reads < 3 ? undefined : object());
    },
    put() {
      writes++;
      return Promise.resolve();
    },
  };
  const upload = uploadAssets(manifest, () => Promise.resolve(bytes), transport);
  await vi.runAllTimersAsync();
  await upload;
  assert.equal(writes, 1);
  assert.equal(reads, 3);
});

test('network retry limits remain bounded and authorization failures stop immediately', async () => {
  vi.useFakeTimers();
  let attempts = 0;
  const transport: AssetTransport = {
    get() {
      attempts++;
      return Promise.reject(new TransientError('offline'));
    },
    put() {
      return Promise.resolve();
    },
  };
  const verification = assert.rejects(verifyAssets(manifest, transport), /offline/u);
  await vi.runAllTimersAsync();
  await verification;
  assert.equal(attempts, 3);
  attempts = 0;
  transport.get = () => {
    attempts++;
    return Promise.reject(new Error('denied'));
  };
  await assert.rejects(verifyAssets(manifest, transport), /denied/u);
  assert.equal(attempts, 1);
});

test('upload capabilities accept only exact manifest keys in the reviewed regional bucket', () => {
  const bucket = 'reviewed-georoids-assets';
  const signed = `https://${bucket}.s3.us-east-1.amazonaws.com/${asset.key}?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=fake`;
  assertUploadTarget(manifest, bucket, asset.key, signed);
  assert.throws(
    () => assertUploadTarget(manifest, bucket, asset.key, 'invalid credential'),
    /value omitted/u
  );
  assert.throws(() => assertUploadTarget(manifest, 'other-bucket', asset.key, signed));
  assert.throws(() => assertUploadTarget(manifest, bucket, 'wrong-key', signed));
  assert.throws(() =>
    assertUploadTarget(manifest, bucket, asset.key, signed.replace('https:', 'http:'))
  );
});

test('the real CLI verifies the repository manifest without AWS credentials or another checkout', async () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const cli = fileURLToPath(new URL('../../../scripts/assets/cli.ts', import.meta.url));
  const result = execFileSync(process.execPath, ['--import', 'tsx', cli, 'check'], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.match(result, /Verified 54 source media files/u);
  const plan = execFileSync(
    process.execPath,
    ['--import', 'tsx', cli, 'plan', 'reviewed-georoids-assets'],
    { cwd: root, encoding: 'utf8' }
  );
  assert.equal(plan.trim().split('\n').length, 54);
  assert.ok(
    plan
      .trim()
      .split('\n')
      .every(
        (line) => line.startsWith('aws s3api put-object ') && line.includes("--if-none-match '*'")
      )
  );
  assert.equal(
    JSON.parse(await readFile(join(root, 'config/aws/static-assets/manifest.json'), 'utf8'))
      .version,
    1
  );
});

test('the stack retains private versioned encrypted storage restricted to its signed distribution', () => {
  const resources = template.Resources;
  assert.equal(resources.MediaBucket.DeletionPolicy, 'Retain');
  assert.equal(resources.MediaBucket.UpdateReplacePolicy, 'Retain');
  assert.equal(resources.MediaBucket.Properties.VersioningConfiguration.Status, 'Enabled');
  assert.ok(
    Object.values(resources.MediaBucket.Properties.PublicAccessBlockConfiguration).every(Boolean)
  );
  assert.equal(
    resources.MediaBucket.Properties.OwnershipControls.Rules[0]?.ObjectOwnership,
    'BucketOwnerEnforced'
  );
  assert.equal(
    resources.OriginAccess.Properties.OriginAccessControlConfig.SigningBehavior,
    'always'
  );
  assert.equal(resources.MediaCache.Properties.CachePolicyConfig.MinTTL, 0);
  assert.equal(resources.MediaCache.Properties.CachePolicyConfig.MaxTTL, 31536000);
  assert.ok(JSON.stringify(resources.MediaBucketPolicy).includes('AWS:SourceArn'));
  assert.ok(JSON.stringify(resources.MediaBucketPolicy).includes('/sha256/*'));
  assert.ok(JSON.stringify(resources.MediaBucketPolicy).includes('aws:SecureTransport'));
});

test('a manifest edit during network verification cannot produce a preservation receipt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'georoids-verification-'));
  const cli = fileURLToPath(new URL('../../../scripts/assets/cli.ts', import.meta.url));
  const tsx = fileURLToPath(new URL('../../../node_modules/tsx/dist/loader.mjs', import.meta.url));
  const manifestPath = join(root, 'config/aws/static-assets/manifest.json');
  const receipt = join(root, 'receipt.json');
  const mock = join(root, 'fetch.mjs');
  try {
    await mkdir(join(root, 'config/aws/static-assets'), { recursive: true });
    await writeFile(manifestPath, JSON.stringify(manifest));
    await writeFile(
      mock,
      `import { writeFileSync } from 'node:fs';
globalThis.fetch = async () => {
  writeFileSync(${JSON.stringify(manifestPath)}, '{}');
  return new Response(new Uint8Array(${JSON.stringify([...bytes])}), { headers: { 'content-type': 'audio/ogg', 'cache-control': ${JSON.stringify(CACHE_CONTROL)} } });
};`
    );
    const result = spawnSync(
      process.execPath,
      ['--import', tsx, '--import', mock, cli, 'verify', 'https://d123.cloudfront.net', receipt],
      { cwd: root, encoding: 'utf8' }
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Manifest changed during verification/u);
    await assert.rejects(readFile(receipt));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('malformed authorization files cannot expose credential canaries in parser diagnostics', async () => {
  const root = await mkdtemp(join(tmpdir(), 'georoids-authorization-'));
  const cli = fileURLToPath(new URL('../../../scripts/assets/cli.ts', import.meta.url));
  const tsx = fileURLToPath(new URL('../../../node_modules/tsx/dist/loader.mjs', import.meta.url));
  const authorization = join(root, 'authorization.json');
  const canary = 'do-not-echo-this-credential';
  try {
    await mkdir(join(root, 'config/aws/static-assets'), { recursive: true });
    await writeFile(join(root, 'config/aws/static-assets/manifest.json'), JSON.stringify(manifest));
    await writeFile(authorization, `{ malformed "${canary}"`);
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        tsx,
        cli,
        'upload',
        'https://d123.cloudfront.net',
        'reviewed-georoids-assets',
        authorization,
      ],
      { cwd: root, encoding: 'utf8' }
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Invalid upload authorization map/u);
    assert.equal(`${result.stderr}${result.stdout}`.includes(canary), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
