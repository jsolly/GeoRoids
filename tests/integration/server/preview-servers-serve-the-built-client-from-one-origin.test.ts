import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { createServerInstance } from '../../../server/createServer';
import { config as vercelConfig } from '../../../vercel';

const servers: ReturnType<typeof createServerInstance>[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function builtClient(): Promise<string> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'georoids-preview-client-'));
  directories.push(workspace);
  const root = path.join(workspace, 'dist');
  await mkdir(path.join(root, 'debug'), { recursive: true });
  await mkdir(path.join(root, 'wiki'), { recursive: true });
  await mkdir(path.join(root, '_astro'), { recursive: true });
  await writeFile(path.join(root, 'index.html'), '<title>game</title>');
  await writeFile(path.join(root, 'debug', 'index.html'), '<title>debug</title>');
  await writeFile(path.join(root, 'wiki', 'index.html'), '<title>wiki</title>');
  await writeFile(path.join(root, 'release.json'), '{"releaseId":"a"}');
  await writeFile(path.join(root, 'client-assets.json'), '{"modules":[]}');
  await writeFile(path.join(root, '_astro', 'entry.js'), 'export {};');
  await writeFile(path.join(workspace, 'secret.txt'), 'outside the client');
  await symlink(path.join(workspace, 'secret.txt'), path.join(root, 'escape.txt'));
  // A sibling whose name extends the root's must not count as inside it.
  await mkdir(path.join(workspace, 'dist-private'));
  await writeFile(path.join(workspace, 'dist-private', 'key.txt'), 'sibling of the client');
  // Client files named like server routes must never shadow them.
  await writeFile(path.join(root, 'health'), 'client health');
  await writeFile(path.join(root, 'ws'), 'client ws');
  await writeFile(path.join(root, 'logs'), 'client logs');
  await mkdir(path.join(root, 'status'));
  await writeFile(path.join(root, 'status', 'index.html'), '<title>client status</title>');
  // A self-referencing link fails with ELOOP: a broken build, not a missing file.
  await symlink(path.join(root, 'loop.js'), path.join(root, 'loop.js'));
  return root;
}

async function start(serveClientFrom?: string): Promise<string> {
  const server = createServerInstance({
    port: 0,
    nodeEnv: 'test',
    ...(serveClientFrom != null && serveClientFrom !== '' ? { serveClientFrom } : {}),
  });
  servers.push(server);
  return `http://127.0.0.1:${await server.listening}`;
}

/** Sends the path byte-for-byte; fetch would normalize dot segments before the server sees them. */
function rawGet(origin: string, rawPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const outgoing = request(`${origin}/`, { path: rawPath }, (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    outgoing.on('error', reject);
    outgoing.end();
  });
}

test('a preview server answers every client route and manifest from its own origin', async () => {
  const origin = await start(await builtClient());

  for (const [route, title] of [
    ['/', 'game'],
    ['/debug', 'debug'],
    ['/debug/', 'debug'],
    ['/wiki?topic=towing', 'wiki'],
  ] as const) {
    const response = await fetch(`${origin}${route}`, { redirect: 'error' });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    // Pages revalidate so the next /preview replaces them without a stale cache.
    expect(response.headers.get('cache-control')).toBe('public, max-age=0, must-revalidate');
    expect(await response.text()).toBe(`<title>${title}</title>`);
  }

  const script = await fetch(`${origin}/_astro/entry.js`);
  expect(script.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
  expect(script.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
  expect(script.headers.get('x-content-type-options')).toBe('nosniff');

  const head = await fetch(`${origin}/`, { method: 'HEAD' });
  expect(head.status).toBe(200);
  expect(head.headers.get('content-type')).toBe('text/html; charset=utf-8');
  expect(head.headers.get('content-length')).toBe(String('<title>game</title>'.length));
  expect((await fetch(`${origin}/`, { method: 'POST' })).status).toBe(405);
  expect((await fetch(`${origin}/missing.js`)).status).toBe(404);
});

test('a preview server never serves files outside the built client', async () => {
  const origin = await start(await builtClient());

  // Encoded separators survive URL normalization and reach the containment check.
  expect(await rawGet(origin, '/..%2fsecret.txt')).toBe(404);
  expect(await rawGet(origin, '/..%2fdist-private%2fkey.txt')).toBe(404);
  expect(await rawGet(origin, '/escape.txt')).toBe(404);
  expect(await rawGet(origin, '/%00')).toBe(400);
  expect(await rawGet(origin, '/..%5csecret.txt')).toBe(400);
  expect(await rawGet(origin, '/%E0%A4%A')).toBe(400);
});

test('a preview server reports a broken client file instead of hiding it as missing', async () => {
  const origin = await start(await builtClient());

  const response = await fetch(`${origin}/loop.js`);
  expect(response.status).toBe(500);
  expect(await response.text()).toBe('');
  expect((await fetch(`${origin}/`)).status).toBe(200);
});

test('preview manifests stay uncached exactly as vercel.ts serves them in production', async () => {
  const uncached = (vercelConfig.headers ?? [])
    .filter(({ headers }) =>
      headers.some(({ key, value }) => key === 'Cache-Control' && value === 'no-store')
    )
    .map(({ source }) => source);
  expect(uncached.length).toBeGreaterThan(0);
  const origin = await start(await builtClient());

  for (const source of uncached) {
    const response = await fetch(`${origin}${source}`, { redirect: 'error' });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
  }
});

test('a preview server refuses to start without a built client', async () => {
  const root = await builtClient();
  await rm(path.join(root, 'index.html'));

  expect(() => createServerInstance({ port: 0, nodeEnv: 'test', serveClientFrom: root })).toThrow(
    'Preview client requires a built client'
  );
});

test('exact server routes keep precedence over preview client files', async () => {
  const origin = await start(await builtClient());

  const health = await fetch(`${origin}/health`);
  expect(health.headers.get('content-type')).toBe('application/json');
  expect(await health.json()).toHaveProperty('releaseId');
  for (const socketRoute of ['/ws', '/logs']) {
    const response = await fetch(`${origin}${socketRoute}`);
    expect(response.status).toBe(426);
    expect(await response.text()).toBe('WebSocket connections should use ws:// protocol');
  }
  const status = await fetch(`${origin}/status`, { headers: { Accept: 'application/json' } });
  expect(status.headers.get('content-type')).toBe('application/json');
  expect(await status.json()).toHaveProperty('websockets');
});

test('a production server without a client root serves no client files', async () => {
  const origin = await start();

  const root = await fetch(`${origin}/`);
  expect(root.headers.get('content-type')).toBe('text/plain');
  expect(await root.text()).toBe('GeoRoids Game Server - Running');
  expect((await fetch(`${origin}/index.html`)).status).toBe(404);
  expect((await fetch(`${origin}/release.json`)).status).toBe(404);
});
