/* @vitest-environment node */
import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { createRailwayContext, project, type ServiceNode } from 'railway/iac';
import { afterEach, expect, test } from 'vitest';
import { WebSocket } from 'ws';
import railwayConfig from '../../../.railway/railway';
import { WorldStore } from '../../../server/world/WorldStore';
import { SNAPSHOT_VERSION, SnapshotDecoder } from '../../../shared/snapshotProtocol';
import type { ServerGameSnapshot } from '../../../shared-types';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const WHITESPACE_SPLIT_PATTERN = /\s+/u;
const SERVER_LISTENING_PORT_PATTERN = /Server listening on port (\d+)/u;
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

function start(
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
  const [command, ...args] = railwayStartCommand.split(WHITESPACE_SPLIT_PATTERN);
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
      const match = output.match(SERVER_LISTENING_PORT_PATTERN);
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
          this.send('snapshotAck', { sequence: result.metadata.sequence });
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
      snapshotVersion: SNAPSHOT_VERSION,
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
  const client = new Pilot(
    connect(port, `/ws?other=kept&snapshotVersion=${SNAPSHOT_VERSION}&asteroidInteractions=1`)
  );
  await once(client.ws, 'open', { signal: AbortSignal.timeout(5000) });
  return client;
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
  await waitFor(
    () => first.states.find((state) => state.exploration.length > 0),
    'shared exploration after join'
  );
  await stopProduction();
  expect(output).toContain('Server closed');
  const store = new WorldStore(path);
  const savedWorld = store.loadWorld();
  const savedPilot = store.loadPilots().find((row) => row.id === 'persisted-pilot');
  store.close();
  expect(savedWorld?.exploration.length).toBeGreaterThan(0);
  expect(savedPilot?.id).toBe('persisted-pilot');
  expect(savedPilot?.lastSeenAt).toEqual(expect.any(Number));

  const nextPort = await start(0, path);
  const returning = await pilot(nextPort);
  const resumed = await returning.join('new-connection', joined['resumeToken']);
  expect(resumed['id']).toBe('persisted-pilot');
  const restored = (await returning.state()).entities.find(
    (entity) => entity.id === 'persisted-pilot'
  );
  expect(restored?.position).toEqual(savedPilot?.position);
  expect(restored?.score).toBeGreaterThanOrEqual(savedPilot?.score ?? 0);
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
