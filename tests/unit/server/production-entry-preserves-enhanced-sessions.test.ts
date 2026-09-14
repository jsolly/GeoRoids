/* @vitest-environment node */
import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRailwayContext, project, type ServiceNode } from 'railway/iac';
import { afterEach, expect, test } from 'vitest';
import { WebSocket } from 'ws';
import railwayConfig from '../../../.railway/railway';
import { WorldStore } from '../../../server/world/WorldStore';
import { SnapshotDecoder } from '../../../shared/snapshotProtocol';
import type { ServerGameSnapshot } from '../../../shared-types';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const railwayProject = await railwayConfig(createRailwayContext({ command: 'test' }), project);
const railwayService = railwayProject.resources
  ?.flat()
  .find(
    (resource): resource is ServiceNode =>
      resource.type === 'service' && resource.name === 'geoasteroids'
  );
let child: ChildProcess | undefined;
let output = '';
const sockets: WebSocket[] = [];
const directories: string[] = [];

async function waitFor<T>(read: () => T | undefined, label: string, timeout = 5000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) {
      return value;
    }
    if (child && (child.exitCode !== null || child.signalCode !== null)) {
      throw new Error(`Production entry exited: ${output}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${label}: ${output.slice(-6000)}`);
}

function worldDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'georoids-production-world-'));
  directories.push(directory);
  return directory;
}

async function start(
  port = 0,
  worldPath: string | null = join(worldDirectory(), 'world.sqlite'),
  mountPath: string | null = worldPath === null ? null : dirname(worldPath),
  nodeEnv: string | null = 'production'
): Promise<number> {
  const railwayStartCommand = railwayService?.deploy?.startCommand;
  if (!railwayStartCommand) {
    throw new Error('Railway IaC service start command is missing');
  }
  output = '';
  const [command, ...args] = railwayStartCommand.split(/\s+/);
  if (!command) {
    throw new Error('Railway start command is empty');
  }
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    VITEST: 'false',
    PORT: String(port),
    SERVER_LOG_LEVEL: 'info',
  };
  delete env['GEOROIDS_WORLD_PATH'];
  delete env['RAILWAY_VOLUME_MOUNT_PATH'];
  delete env['NODE_ENV'];
  if (nodeEnv !== null) {
    env['NODE_ENV'] = nodeEnv;
  }
  if (worldPath !== null) {
    env['GEOROIDS_WORLD_PATH'] = worldPath;
  }
  if (mountPath !== null) {
    env['RAILWAY_VOLUME_MOUNT_PATH'] = mountPath;
  }
  child = spawn(command, args, {
    cwd: repo,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (data) => {
    output = (output + String(data)).slice(-100_000);
  });
  child.stderr?.on('data', (data) => {
    output = (output + String(data)).slice(-100_000);
  });
  return waitFor(
    () => {
      const match = output.match(/Server listening on port (\d+)/);
      return match ? Number(match[1]) : undefined;
    },
    'actual production listener',
    15_000
  );
}

function connect(port: number, path: string): WebSocket {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
  ws.on('error', () => undefined);
  sockets.push(ws);
  return ws;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

class Pilot {
  readonly packets: Array<{ type: string; data?: unknown }> = [];
  readonly states: ServerGameSnapshot[] = [];
  readonly failures: unknown[] = [];
  private readonly decoder = new SnapshotDecoder();
  constructor(readonly ws: WebSocket) {
    ws.on('message', (raw) => {
      try {
        const text = String(raw);
        const result = this.decoder.readMessage(text, { acceptSnapshots: true });
        if (result.kind === 'snapshot-rejected') {
          throw result.error;
        }
        if (result.kind === 'snapshot') {
          this.packets.push({ type: 'snapshot', data: result.metadata });
          this.states.push(result.state);
          return;
        }
        const packet = result.message;
        if (!isRecord(packet) || typeof packet['type'] !== 'string') {
          throw new Error('Server packet is missing its type');
        }
        this.packets.push({ ...packet, type: packet['type'] });
        if (packet['type'] === 'joined') {
          this.decoder.reset();
        }
      } catch (error) {
        this.failures.push(error);
      }
    });
  }
  send(type: string, data: Record<string, unknown> = {}): void {
    this.ws.send(JSON.stringify({ type, data }));
  }
  async join(id: string, resumeToken?: unknown): Promise<Record<string, unknown>> {
    this.send('join', {
      id,
      name: id,
      kitId: 'hauler',
      position: { x: id === 'observer' ? -2000 : 2000, y: 0 },
      snapshotVersion: 1,
      asteroidInteractions: 1,
      ...(resumeToken ? { resumeToken } : {}),
    });
    const data = await waitFor(
      () => this.packets.find((packet) => packet.type === 'joined')?.data,
      `join ${id}`
    );
    if (!isRecord(data)) {
      throw new Error('Joined packet is missing its data object');
    }
    return data;
  }
  async state(): Promise<ServerGameSnapshot> {
    const pong = once(this.ws, 'pong', { signal: AbortSignal.timeout(5000) });
    this.ws.ping();
    await pong;
    const after = this.states.length;
    this.send('snapshotResync');
    const state = await waitFor(() => this.states[after], 'post-command decoded snapshot');
    expect(this.failures).toEqual([]);
    return state;
  }
}

async function pilot(port: number): Promise<Pilot> {
  const client = new Pilot(connect(port, '/ws?other=kept&asteroidInteractions=1'));
  await once(client.ws, 'open', { signal: AbortSignal.timeout(5000) });
  return client;
}

async function disconnect(ws: WebSocket): Promise<void> {
  const closed = once(ws, 'close', { signal: AbortSignal.timeout(5000) });
  ws.close();
  await closed;
}

async function stopProduction(): Promise<void> {
  for (const ws of sockets.splice(0)) {
    if (ws.readyState !== WebSocket.CLOSED) {
      ws.terminate();
    }
  }
  const processToStop = child;
  child = undefined;
  if (!processToStop || processToStop.exitCode !== null || processToStop.signalCode !== null) {
    return;
  }
  const exited = once(processToStop, 'exit', { signal: AbortSignal.timeout(6000) });
  processToStop.kill('SIGTERM');
  const force = setTimeout(() => processToStop.kill('SIGKILL'), 3000);
  try {
    await exited;
  } finally {
    clearTimeout(force);
  }
}

afterEach(async () => {
  try {
    await stopProduction();
  } finally {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test('the production entry restores the same pilot and explored world from its configured database after restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'georoids-production-world-'));
  directories.push(directory);
  const path = join(directory, 'world.sqlite');
  const firstPort = await start(0, path);
  const first = await pilot(firstPort);
  const joined = await first.join('persisted-pilot');
  const snapshot = await first.state();
  expect(snapshot.entities.some((entity) => entity.id === 'persisted-pilot')).toBe(true);
  await stopProduction();
  expect(output).toContain('Server closed');
  const store = new WorldStore(path);
  const savedWorld = store.loadWorld();
  const savedPilot = store.loadPilots().find((row) => row.id === 'persisted-pilot');
  store.close();
  expect(savedWorld?.exploration.length).toBeGreaterThan(0);
  expect(savedPilot?.id).toBe('persisted-pilot');

  const nextPort = await start(0, path);
  const returning = await pilot(nextPort);
  const resumed = await returning.join('new-connection', joined['resumeToken']);
  expect(resumed['id']).toBe('persisted-pilot');
  const restored = (await returning.state()).entities.find(
    (entity) => entity.id === 'persisted-pilot'
  );
  expect(restored?.score).toBe(savedPilot?.score);
  expect(restored?.lives).toBe(savedPilot?.lives);
  await stopProduction();
  const reopened = new WorldStore(path);
  try {
    expect(reopened.loadWorld()?.seed).toBe(savedWorld?.seed);
    expect(reopened.loadWorld()?.startedAt).toBe(savedWorld?.startedAt);
    expect(reopened.loadWorld()?.exploration.length).toBeGreaterThanOrEqual(
      savedWorld?.exploration.length ?? 0
    );
  } finally {
    reopened.close();
  }
}, 25_000);

test('the production entry refuses to start without a persistent world path', async () => {
  await expect(start(0, null)).rejects.toThrow('Production entry exited');
  expect(child?.exitCode).not.toBe(0);
  expect(output).toContain('GEOROIDS_WORLD_PATH must point to the mounted persistent world volume');
});

test.each(['missing mount', 'different directory', 'in-memory database'])(
  'the production entry refuses an ephemeral world with %s',
  async (scenario) => {
    const directory = worldDirectory();
    const path = scenario === 'in-memory database' ? ':memory:' : join(directory, 'world.sqlite');
    const mount = scenario === 'missing mount' ? null : worldDirectory();
    await expect(start(0, path, mount)).rejects.toThrow('Production entry exited');
    expect(child?.exitCode).toBe(1);
    expect(output).toContain(
      'Production world database must be directly inside RAILWAY_VOLUME_MOUNT_PATH'
    );
    expect(existsSync(join(directory, 'world.sqlite'))).toBe(false);
  }
);

test.each([null, '', 'staging'])(
  'a non-development deployment refuses an unmounted database with NODE_ENV=%s',
  async (nodeEnv) => {
    const path = join(worldDirectory(), 'world.sqlite');
    await expect(start(0, path, null, nodeEnv)).rejects.toThrow('Production entry exited');
    expect(child?.exitCode).toBe(1);
    expect(output).toContain(
      'Production world database must be directly inside RAILWAY_VOLUME_MOUNT_PATH'
    );
    expect(existsSync(path)).toBe(false);
  }
);

test('the actual production entry rejects stale upgrades, keeps HTTP/logs, and resumes pilots through transport grace', async () => {
  const port = await start();
  const base = `http://127.0.0.1:${port}`;
  const health = await fetch(`${base}/health`, { signal: AbortSignal.timeout(5000) });
  expect(health.status).toBe(200);
  expect(health.headers.get('x-release-id')).toBeTruthy();
  expect(await health.json()).toHaveProperty('status', 'healthy');
  const status = await fetch(`${base}/status`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(5000),
  });
  expect(await status.json()).toHaveProperty('server.nodeEnv', 'production');
  expect(
    await (await fetch(`${base}/status`, { signal: AbortSignal.timeout(5000) })).text()
  ).toContain('connectGame()');
  expect(await (await fetch(base, { signal: AbortSignal.timeout(5000) })).text()).toContain(
    'GeoRoids Game Server'
  );
  expect((await fetch(base, { method: 'OPTIONS', signal: AbortSignal.timeout(5000) })).status).toBe(
    200
  );

  for (const path of ['/ws', '/ws?asteroidInteractions=0']) {
    const stale = connect(port, path);
    let opened = false;
    stale.on('open', () => {
      opened = true;
    });
    await expect(once(stale, 'open', { signal: AbortSignal.timeout(5000) })).rejects.toThrow('426');
    expect(opened).toBe(false);
  }
  const logs = connect(port, '/logs?source=entry-test');
  await once(logs, 'open', { signal: AbortSignal.timeout(5000) });
  expect(logs.readyState).toBe(WebSocket.OPEN);

  const observer = await pilot(port);
  await observer.join('observer');
  const original = await pilot(port);
  const joined = await original.join('entry-pilot');
  expect(joined).toMatchObject({ id: 'entry-pilot', snapshotVersion: 1, asteroidInteractions: 1 });
  expect(joined['resumeToken']).toMatch(/^[a-f0-9]{64}$/);
  const before = await observer.state();
  const epoch = before.entities.find((row) => row.id === 'entry-pilot')?.playerMotion?.epoch;
  expect(epoch).toBeGreaterThan(0);
  expect(JSON.stringify(before)).not.toContain(String(joined['resumeToken']));
  const packetStart = observer.packets.length;
  await disconnect(original.ws);
  // Cross a broadcast interval so the server close callback has really run.
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect((await observer.state()).entities.some((row) => row.id === 'entry-pilot')).toBe(true);
  expect(
    observer.packets
      .slice(packetStart)
      .some(
        (packet) =>
          packet.type === 'playerLeft' &&
          isRecord(packet.data) &&
          packet.data['id'] === 'entry-pilot'
      )
  ).toBe(false);
  const resumed = await pilot(port);
  expect(await resumed.join('forged-new-id', joined['resumeToken'])).toMatchObject({
    id: 'entry-pilot',
    resumeToken: joined['resumeToken'],
    asteroidInteractions: 1,
  });
  expect(
    (await observer.state()).entities.find((row) => row.id === 'entry-pilot')?.playerMotion?.epoch
  ).toBe(epoch);
  await disconnect(resumed.ws);
  await waitFor(
    () =>
      observer.states.at(-1)?.entities.some((row) => row.id === 'entry-pilot') === false
        ? true
        : undefined,
    'grace expiry removes pilot'
  );
  const expired = await pilot(port);
  expired.send('join', {
    id: 'expired',
    snapshotVersion: 1,
    asteroidInteractions: 1,
    resumeToken: joined['resumeToken'],
  });
  await waitFor(
    () => expired.packets.find((packet) => packet.type === 'error'),
    'expired token rejection'
  );
  expect(expired.packets.some((packet) => packet.type === 'joined')).toBe(false);
}, 25_000);

test('the production entry completes SIGTERM shutdown and exits successfully', async () => {
  const port = await start();
  const client = connect(port, '/logs');
  await once(client, 'open', { signal: AbortSignal.timeout(5000) });
  if (!child) {
    throw new Error('Production child missing');
  }
  const exited = once(child, 'exit', { signal: AbortSignal.timeout(5000) });
  const closed = once(client, 'close', { signal: AbortSignal.timeout(5000) });
  expect(child.kill('SIGTERM')).toBe(true);
  expect(await exited).toEqual([0, null]);
  expect((await closed)[0]).toBe(1001);
  expect(output).toContain('Server closed');
});

test('an occupied production listener fails promptly with a nonzero exit and the cause', async () => {
  const occupied = createServer();
  occupied.listen(0);
  await once(occupied, 'listening', { signal: AbortSignal.timeout(5000) });
  try {
    const address = occupied.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected an ephemeral TCP listener');
    }
    await expect(start(address.port)).rejects.toThrow('Production entry exited');
    expect(child?.exitCode).toBe(1);
    expect(output).toContain('Failed to start server listener');
    expect(output).toContain('EADDRINUSE');
  } finally {
    await new Promise<void>((resolve, reject) =>
      occupied.close((error) => (error ? reject(error) : resolve()))
    );
  }
});
