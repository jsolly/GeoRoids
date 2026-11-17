/* @vitest-environment node */

import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline';
import { afterEach, expect, test } from 'vitest';
import { WorldStore } from '../../../server/world/WorldStore';
import { WORLD } from '../../../shared/world';

const children: ChildProcess[] = [];
const sockets: Socket[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const socket of sockets.splice(0)) {
    socket.destroy();
  }
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit', { signal: AbortSignal.timeout(5000) });
      child.kill('SIGTERM');
      try {
        await exited;
      } catch (error) {
        const killed = once(child, 'exit');
        child.kill('SIGKILL');
        await killed;
        throw error;
      }
    }
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixtureDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'georoids-maintenance-'));
  directories.push(directory);
  return directory;
}

async function start(worldPath: string, preload?: string) {
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      ...(preload === undefined ? [] : ['--import', preload]),
      'server/maintenance.ts',
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PORT: '0',
        NODE_ENV: 'production',
        GEOROIDS_WORLD_PATH: worldPath,
        GEOROIDS_BACKUP_ENABLED: '1',
        RAILWAY_GIT_COMMIT_SHA: 'a'.repeat(40),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  children.push(child);
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const lines = createInterface({ input: child.stdout });
  const waiting = new AbortController();
  const signal = AbortSignal.any([waiting.signal, AbortSignal.timeout(10000)]);
  try {
    const line = await Promise.race([
      once(lines, 'line', { signal }).then(([value]) => String(value)),
      once(child, 'close', { signal }).then(([code]) => {
        throw new Error(`Maintenance exited before readiness (${String(code)}): ${stderr}`);
      }),
    ]);
    const ready: unknown = JSON.parse(line);
    if (
      ready === null ||
      typeof ready !== 'object' ||
      !('port' in ready) ||
      typeof ready.port !== 'number'
    ) {
      throw new Error(`Invalid maintenance readiness: ${line}`);
    }
    expect(ready).toEqual({
      event: 'world_maintenance_ready',
      port: ready.port,
      status: 'maintenance',
      gameplayAvailable: false,
      worldOpened: false,
      releaseId: 'a'.repeat(40),
    });
    return { child, port: ready.port, origin: `http://127.0.0.1:${ready.port}` };
  } finally {
    waiting.abort();
    lines.close();
  }
}

async function health(origin: string): Promise<void> {
  const response = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(3000) });
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.json()).toEqual({
    status: 'maintenance',
    gameplayAvailable: false,
    worldOpened: false,
    releaseId: 'a'.repeat(40),
  });
  const head = await fetch(`${origin}/health`, {
    method: 'HEAD',
    signal: AbortSignal.timeout(3000),
  });
  expect(head.status).toBe(200);
  expect(await head.text()).toBe('');
}

test('maintenance rejects public gameplay and commands, creates no world, and closes idle peers on shutdown', async () => {
  const directory = fixtureDirectory();
  const worldPath = join(directory, 'must-not-exist.sqlite');
  const { child, port, origin } = await start(worldPath);
  await health(origin);
  for (const { method, path } of [
    { method: 'GET', path: '/' },
    { method: 'GET', path: '/status' },
    { method: 'POST', path: '/health' },
    { method: 'POST', path: '/debug' },
    { method: 'POST', path: '/test/reset-world' },
    { method: 'POST', path: '/activate' },
  ]) {
    const response = await fetch(`${origin}${path}`, {
      method,
      ...(method === 'POST' ? { body: 'private-operator-input' } : {}),
      signal: AbortSignal.timeout(3000),
    });
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('private-operator-input');
  }
  const peer = createConnection({ host: '127.0.0.1', port });
  sockets.push(peer);
  peer.setTimeout(3000, () => peer.destroy(new Error('Upgrade response did not close')));
  await once(peer, 'connect');
  const capabilities = new URLSearchParams({
    snapshotVersion: '3',
    asteroidInteractions: '1',
    explorationVersion: '1',
    cooperativeVersion: '1',
  });
  peer.write(
    [
      `GET /ws?${capabilities} HTTP/1.1`,
      'Host: localhost',
      'Connection: Upgrade',
      'Upgrade: websocket',
      'Sec-WebSocket-Version: 13',
      `Sec-WebSocket-Key: ${Buffer.alloc(16, 1).toString('base64')}`,
      '',
      '',
    ].join('\r\n')
  );
  let upgradeResponse = '';
  for await (const chunk of peer) {
    upgradeResponse += String(chunk);
  }
  expect(upgradeResponse).toBe(
    'HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'
  );
  const idle = createConnection({ host: '127.0.0.1', port });
  sockets.push(idle);
  await once(idle, 'connect');
  const peerClosed = once(idle, 'close', { signal: AbortSignal.timeout(5000) });
  const exited = once(child, 'exit', { signal: AbortSignal.timeout(5000) });
  child.kill('SIGTERM');
  expect(await exited).toEqual([0, null]);
  await peerClosed;
  expect(existsSync(worldPath)).toBe(false);
  expect(readdirSync(directory)).toEqual([]);
});

test('an operator can inspect the existing world while maintenance retains byte-identical data', async () => {
  const directory = fixtureDirectory();
  const worldPath = join(directory, 'world.sqlite');
  const store = new WorldStore(worldPath);
  store.checkpoint(
    { seed: 83, startedAt: 10000, generation: WORLD.generation, exploration: [] },
    new Map(),
    [{ id: 'retained-pilot', name: 'Retained pilot', tokenHash: 'b'.repeat(64), score: 7300 }]
  );
  store.close();
  const before = readFileSync(worldPath);
  const files = readdirSync(directory);
  const { child, origin } = await start(worldPath);
  await health(origin);
  expect(readFileSync(worldPath)).toEqual(before);
  expect(readdirSync(directory)).toEqual(files);
  const inspection = spawnSync(
    process.execPath,
    ['--import', 'tsx', 'scripts/migrate-cooperative-world.ts', 'inspect', worldPath],
    { encoding: 'utf8', cwd: process.cwd(), timeout: 10000 }
  );
  expect(inspection.status).toBe(0);
  expect(JSON.parse(inspection.stdout)).toMatchObject({
    mode: 'inspect',
    cooperative: null,
    legacyRowsPreserved: true,
  });
  // A read-only SQLite connection can create WAL/SHM sidecars. Attribute those
  // to the explicit operator command, then prove maintenance changes none of them.
  const inspectedFiles = readdirSync(directory);
  const inspectedBytes = inspectedFiles.map((file) => readFileSync(join(directory, file)));
  await health(origin);
  const exited = once(child, 'exit', { signal: AbortSignal.timeout(5000) });
  child.kill('SIGINT');
  expect(await exited).toEqual([0, null]);
  expect(readFileSync(worldPath)).toEqual(before);
  expect(readdirSync(directory)).toEqual(inspectedFiles);
  expect(inspectedFiles.map((file) => readFileSync(join(directory, file)))).toEqual(inspectedBytes);
});

test.each(['SIGTERM', 'SIGINT'])(
  'maintenance has armed %s shutdown when it publishes readiness',
  async (signal) => {
    const directory = fixtureDirectory();
    const worldPath = join(directory, 'must-not-exist.sqlite');
    const preload = join(directory, 'signal-at-readiness.mjs');
    // Inject signal dispatch at the observable stdout boundary. This catches
    // ready-before-handlers deterministically rather than racing the OS scheduler.
    writeFileSync(
      preload,
      `
import process from 'node:process';
const write = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, ...args) => {
  const result = write(chunk, ...args);
  if (String(chunk).includes('"event":"world_maintenance_ready"')) process.emit(${JSON.stringify(signal)});
  return result;
};
`
    );
    const { child } = await start(worldPath, preload);
    const result =
      child.exitCode !== null || child.signalCode !== null
        ? [child.exitCode, child.signalCode]
        : await once(child, 'exit', { signal: AbortSignal.timeout(5000) });
    expect(result).toEqual([0, null]);
    expect(existsSync(worldPath)).toBe(false);
  }
);
