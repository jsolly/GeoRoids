/* @vitest-environment node */
import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, test } from 'vitest';
import { WebSocket } from 'ws';
import { SnapshotDecoder } from '../../../shared/snapshotProtocol';
import type { ServerGameSnapshot } from '../../../shared-types';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
let child: ChildProcess | undefined;
let output = '';
const sockets: WebSocket[] = [];

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

async function start(gated: boolean, port = 0): Promise<number> {
  output = '';
  // Execute the actual Railway entry under tsx, without importing the test factory.
  child = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], {
    cwd: repo,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      VITEST: 'false',
      PORT: String(port),
      REQUIRE_ASTEROID_CLIENT: gated ? '1' : '0',
      SERVER_LOG_LEVEL: 'info',
    },
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

class Pilot {
  readonly packets: Array<{ type: string; data: Record<string, unknown> }> = [];
  readonly states: ServerGameSnapshot[] = [];
  readonly failures: Error[] = [];
  private readonly decoder = new SnapshotDecoder();
  constructor(readonly ws: WebSocket) {
    ws.on('message', (raw) => {
      try {
        const packet = JSON.parse(String(raw));
        this.packets.push(packet);
        if (packet.type === 'joined') {
          this.decoder.reset();
        }
        if (packet.type === 'snapshot') {
          this.states.push(this.decoder.decode(packet.data));
        }
      } catch (error) {
        this.failures.push(error as Error);
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
      factionId: 'ion',
      position: { x: id === 'observer' ? -2000 : 2000, y: 0 },
      snapshotVersion: 1,
      asteroidInteractions: 1,
      ...(resumeToken ? { resumeToken } : {}),
    });
    return waitFor(
      () => this.packets.find((packet) => packet.type === 'joined')?.data,
      `join ${id}`
    );
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

afterEach(async () => {
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
});

test('the actual production entry gates stale upgrades, keeps HTTP/logs, and resumes enhanced pilots through transport grace', async () => {
  const port = await start(true);
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
  const epoch = before.entities.find((row) => row.id === 'entry-pilot')?.asteroidMotion?.epoch;
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
      .some((packet) => packet.type === 'playerLeft' && packet.data['id'] === 'entry-pilot')
  ).toBe(false);
  const resumed = await pilot(port);
  expect(await resumed.join('forged-new-id', joined['resumeToken'])).toMatchObject({
    id: 'entry-pilot',
    resumeToken: joined['resumeToken'],
    asteroidInteractions: 1,
  });
  expect(
    (await observer.state()).entities.find((row) => row.id === 'entry-pilot')?.asteroidMotion?.epoch
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

test('the actual support entry admits ordinary clients before the cutover flag is enabled', async () => {
  const port = await start(false);
  const ordinary = new Pilot(connect(port, '/ws'));
  await once(ordinary.ws, 'open', { signal: AbortSignal.timeout(5000) });
  ordinary.send('join', { id: 'legacy-entry', name: 'Legacy entry' });
  const joined = await waitFor(
    () => ordinary.packets.find((packet) => packet.type === 'joined')?.data,
    'ordinary production join'
  );
  expect(joined['id']).toBe('legacy-entry');
  expect(joined['resumeToken']).toBeUndefined();
  expect(joined['asteroidInteractions']).toBeUndefined();
}, 20_000);

test('the production entry completes SIGTERM shutdown and exits successfully', async () => {
  const port = await start(true);
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
    await expect(start(true, address.port)).rejects.toThrow('Production entry exited');
    expect(child?.exitCode).toBe(1);
    expect(output).toContain('Failed to start server listener');
    expect(output).toContain('EADDRINUSE');
  } finally {
    await new Promise<void>((resolve, reject) =>
      occupied.close((error) => (error ? reject(error) : resolve()))
    );
  }
});
