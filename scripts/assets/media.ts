import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';

export const CACHE_CONTROL = 'public, max-age=31536000, immutable';
const PUBLIC_PATH =
  /^\/(?:(?:music\/[a-z0-9-]+\.(?:ogg|mp3))|(?:sounds\/[a-z0-9-]+\.m4a)|(?:wiki\/(?:media|uploads)\/[a-zA-Z0-9_./-]+\.(?:webp|png|jpe?g|gif))|favicon\.ico)$/u;
type MediaType =
  | 'image/webp'
  | 'image/png'
  | 'image/jpeg'
  | 'image/gif'
  | 'image/vnd.microsoft.icon'
  | 'audio/mpeg'
  | 'audio/ogg'
  | 'audio/mp4';
const DISTRIBUTION = /^d[a-z0-9]+\.cloudfront\.net$/u;
const TYPES: Readonly<Record<string, MediaType>> = {
  webp: 'image/webp',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  ico: 'image/vnd.microsoft.icon',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
};
export const digest = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');
export interface Asset {
  path: string;
  sha256: string;
  bytes: number;
  contentType: MediaType;
  key: string;
}
export interface AssetManifest {
  version: 1;
  assets: Asset[];
}
function properties(value: unknown): Map<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Expected an object');
  }
  return new Map<string, unknown>(Object.entries(value));
}
export function parseManifest(value: unknown): AssetManifest {
  const manifest = properties(value);
  const rows = manifest.get('assets');
  if (
    manifest.size !== 2 ||
    manifest.get('version') !== 1 ||
    !Array.isArray(rows) ||
    !rows.length
  ) {
    throw new Error('Invalid manifest');
  }
  const paths = new Set<string>();
  const assets: Asset[] = rows.map((row: unknown) => {
    const entry = properties(row);
    const path = entry.get('path');
    const sha256 = entry.get('sha256');
    const bytes = entry.get('bytes');
    const key = entry.get('key');
    const mime = entry.get('contentType');
    if (
      entry.size !== 5 ||
      typeof path !== 'string' ||
      !PUBLIC_PATH.test(path) ||
      path.includes('..') ||
      path.includes('//') ||
      paths.has(path) ||
      typeof sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(sha256) ||
      typeof bytes !== 'number' ||
      !Number.isInteger(bytes) ||
      bytes <= 0 ||
      bytes > 100_000_000 ||
      key !== objectKey(path, sha256) ||
      mime !== contentType(path)
    ) {
      throw new Error('Invalid or duplicate manifest asset');
    }
    paths.add(path);
    return { path, sha256, bytes, key, contentType: contentType(path) };
  });
  if (assets.some((asset, i) => i > 0 && (assets[i - 1]?.path ?? '') >= asset.path)) {
    throw new Error('Manifest must be sorted by public path');
  }
  return { version: 1, assets };
}
export function objectKey(path: string, sha256: string): string {
  return `sha256/${sha256}${path}`;
}
function contentType(path: string): MediaType {
  const type = TYPES[path.split('.').at(-1) ?? ''];
  if (!type) {
    throw new Error(`Unsupported media: ${path}`);
  }
  return type;
}

export async function createManifest(
  root: string,
  references: ReadonlySet<string>
): Promise<AssetManifest> {
  const assets: Asset[] = [];
  if ((await lstat(join(root, 'public'))).isSymbolicLink()) {
    throw new Error('Symlink is not an asset input: public');
  }
  for (const path of [...references].sort()) {
    if (!PUBLIC_PATH.test(path) || path.includes('..') || path.includes('//')) {
      throw new Error(`Unsafe public path: ${path}`);
    }
    const local = join(root, 'public', path);
    // Check every component so a parent symlink cannot expose another directory.
    let current = join(root, 'public');
    for (const part of path.slice(1).split('/')) {
      current = join(current, part);
      if ((await lstat(current)).isSymbolicLink()) {
        throw new Error(`Symlink is not an asset input: ${current}`);
      }
    }
    const bytes = await readFile(local);
    const sha256 = digest(bytes);
    assets.push({
      path,
      sha256,
      bytes: bytes.length,
      contentType: contentType(path),
      key: objectKey(path, sha256),
    });
  }
  return parseManifest({ version: 1, assets });
}

export function assertCoverage(manifest: AssetManifest, references: ReadonlySet<string>): void {
  const expected = new Set(manifest.assets.map((asset) => asset.path));
  for (const path of references) {
    if (!expected.has(path)) {
      throw new Error(`Published image missing from manifest: ${path}`);
    }
  }
  for (const path of expected) {
    if (!references.has(path)) {
      throw new Error(`Manifest image is no longer published: ${path}`);
    }
  }
}

export interface ObjectResponse {
  bytes: Uint8Array;
  contentType: string | null;
  cacheControl: string | null;
}
export interface AssetTransport {
  get(asset: Asset): Promise<ObjectResponse | undefined>;
  put(asset: Asset, bytes: Uint8Array): Promise<void>;
}

function assertObject(asset: Asset, response: ObjectResponse): void {
  if (response.bytes.length !== asset.bytes || digest(response.bytes) !== asset.sha256) {
    throw new Error(`Object bytes mismatch: ${asset.path}`);
  }
  if (response.contentType !== asset.contentType || response.cacheControl !== CACHE_CONTROL) {
    throw new Error(`Object headers mismatch: ${asset.path}`);
  }
}

/** Retry transient transport failures only; integrity errors never become permission to overwrite. */
async function retry<T>(operation: () => Promise<T>): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (!(error instanceof TransientError)) {
        throw error;
      }
      last = error;
      if (attempt < 2) {
        await setTimeout(1_100 * (attempt + 1));
      }
    }
  }
  throw last;
}
export class TransientError extends Error {}

export async function verifyAssets(
  manifest: AssetManifest,
  transport: AssetTransport
): Promise<void> {
  for (const asset of manifest.assets) {
    const response = await retry(() => transport.get(asset));
    if (!response) {
      throw new Error(`Missing object: ${asset.path}`);
    }
    assertObject(asset, response);
  }
}

export async function uploadAssets(
  manifest: AssetManifest,
  read: (asset: Asset) => Promise<Uint8Array>,
  transport: AssetTransport
): Promise<void> {
  // Validate all source bytes before the first write.
  for (const asset of manifest.assets) {
    const bytes = await read(asset);
    if (bytes.length !== asset.bytes || digest(bytes) !== asset.sha256) {
      throw new Error(`Local bytes mismatch: ${asset.path}`);
    }
  }
  for (const asset of manifest.assets) {
    const existing = await retry(() => transport.get(asset));
    if (existing) {
      assertObject(asset, existing);
      continue;
    }
    const bytes = await read(asset);
    if (bytes.length !== asset.bytes || digest(bytes) !== asset.sha256) {
      throw new Error(`Local bytes mismatch: ${asset.path}`);
    }
    await retry(() => transport.put(asset, bytes));
    const uploaded = await retry(async () => {
      const response = await transport.get(asset);
      // S3-origin CloudFront errors cache for at least one second, even with TTL 0.
      if (!response) {
        throw new TransientError(`Upload not readable: ${asset.path}`);
      }
      return response;
    });
    assertObject(asset, uploaded);
  }
}

export function deliveryOrigin(value: string): string {
  const url = URL.parse(value);
  if (url === null) {
    throw new Error('Expected the stack HTTPS CloudFront origin; invalid value omitted');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    !DISTRIBUTION.test(url.hostname)
  ) {
    throw new Error("Expected the stack's HTTPS CloudFront origin");
  }
  return url.origin;
}
export function assetUrl(origin: string, asset: Asset): string {
  return `${deliveryOrigin(origin)}/${asset.key}`;
}

export function assertUploadTarget(
  manifest: AssetManifest,
  bucket: string | undefined,
  key: string,
  value: string
): void {
  const url = URL.parse(value);
  if (url === null) {
    throw new Error('Invalid upload authorization URL; credential value omitted');
  }
  if (
    bucket === undefined ||
    bucket.length === 0 ||
    !manifest.assets.some((entry) => entry.key === key) ||
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    url.hash ||
    url.hostname !== `${bucket}.s3.us-east-1.amazonaws.com` ||
    decodeURIComponent(url.pathname) !== `/${key}` ||
    url.searchParams.get('X-Amz-Algorithm') !== 'AWS4-HMAC-SHA256' ||
    !url.searchParams.has('X-Amz-Signature')
  ) {
    throw new Error(
      'Authorization must contain only exact manifest keys on the intended regional S3 endpoint'
    );
  }
}
