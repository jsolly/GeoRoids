/* @vitest-environment node */
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createServerInstance } from '../../../server/createServer';
import { SnapshotDecoder } from '../../../shared/snapshotProtocol';
import type { ServerEntityData, ServerGameSnapshot } from '../../../shared-types';
import { WireClient } from '../../support/wireClient';

interface Packet {
  type: string;
  data?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

class PilotSocket {
  readonly messages: Packet[] = [];
  private readonly wire: WireClient;
  readonly snapshots: ServerGameSnapshot[] = [];
  readonly failures: Error[] = [];
  private readonly decoder = new SnapshotDecoder();

  constructor(readonly ws: WebSocket) {
    this.wire = new WireClient(ws);
    ws.on('message', (raw) => {
      try {
        const text = String(raw);
        const result = this.decoder.readMessage(text, { acceptSnapshots: true });
        if (result.kind === 'snapshot-rejected') {
          throw result.error;
        }
        if (result.kind === 'snapshot') {
          this.snapshots.push(result.state);
          this.messages.push({ type: 'snapshot' });
          return;
        }
        if (!isRecord(result.message) || typeof result.message['type'] !== 'string') {
          throw new Error('Server packet is missing its type');
        }
        const data = result.message['data'];
        const packet: Packet = {
          type: result.message['type'],
          ...(Object.hasOwn(result.message, 'data') ? { data } : {}),
        };
        this.messages.push(packet);
        if (packet.type === 'joined') {
          this.decoder.reset();
        }
      } catch (error) {
        this.failures.push(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  send(type: string, data: Record<string, unknown> = {}): void {
    this.wire.send({ type, data });
  }

  async waitFor<T>(read: () => T | undefined, label: string, timeout = 2500): Promise<T> {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      this.wire.assertHealthy();
      if (this.failures.length) {
        throw this.failures[0];
      }
      const value = read();
      if (value !== undefined) {
        return value;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`Timed out: ${label}; last packet ${JSON.stringify(this.messages.at(-1))}`);
  }

  async barrier(): Promise<void> {
    await this.wire.barrier();
  }

  async state(): Promise<ServerGameSnapshot> {
    await this.barrier();
    const after = this.snapshots.length;
    this.send('snapshotResync');
    return this.waitFor(() => this.snapshots[after], 'post-command decoded snapshot');
  }

  async join(id: string, x: number, resumeToken?: string): Promise<Record<string, unknown>> {
    const after = this.messages.length;
    this.send('join', {
      id,
      name: id,
      position: { x, y: 0 },
      kitId: 'hauler',
      snapshotVersion: 1,
      asteroidInteractions: 1,
      ...(resumeToken ? { resumeToken } : {}),
    });
    return this.waitFor(() => {
      const data = this.messages.slice(after).find((message) => message.type === 'joined')?.data;
      return isRecord(data) ? data : undefined;
    }, `join ${id}`);
  }

  async open(): Promise<void> {
    await this.wire.open();
  }

  async close(): Promise<void> {
    await this.wire.close();
  }
}

let server: ReturnType<typeof createServerInstance> | undefined;
const clients: PilotSocket[] = [];

async function connect(): Promise<PilotSocket> {
  if (!server) {
    throw new Error('Server missing');
  }
  const client = new PilotSocket(
    new WebSocket(`ws://127.0.0.1:${await server.listening}/ws?asteroidInteractions=1`)
  );
  clients.push(client);
  await client.open();
  return client;
}

function entity(state: ServerGameSnapshot, id: string): ServerEntityData {
  const row = state.entities.find((item) => item.id === id);
  if (!row) {
    throw new Error(`Missing ${id} in decoded entities`);
  }
  return row;
}

async function world(observerX = -600) {
  server = createServerInstance({ port: 0, nodeEnv: 'test' });
  await server.listening;
  server.gameEngine.stopGameLoop();
  const pilot = await connect();
  const joined = await pilot.join('pilot', 100);
  const observer = await connect();
  await observer.join('observer', observerX);
  return { pilot, observer, joined, engine: server.gameEngine };
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await server?.close();
  server = undefined;
});

describe('Enhanced player motion cross real gameplay WebSockets', () => {
  it('retains a free session through a physical flap and accepts only its private token', async () => {
    const { pilot, observer, joined, engine } = await world();
    expect(joined['snapshotVersion']).toBe(1);
    expect(joined['asteroidInteractions']).toBe(1);
    expect(joined['resumeToken']).toMatch(/^[a-f0-9]{64}$/);

    const before = entity(await observer.state(), 'pilot');
    expect(before.playerMotion).toMatchObject({ mode: 'free', epoch: 1, ack: 0 });
    expect(JSON.stringify(before)).not.toContain(String(joined['resumeToken']));

    await pilot.close();
    const duringGrace = entity(await observer.state(), 'pilot');
    expect(duringGrace.playerMotion).toMatchObject({ mode: 'free', epoch: 1, ack: 0 });
    expect(
      observer.messages.some(
        (message) =>
          message.type === 'playerLeft' && isRecord(message.data) && message.data['id'] === 'pilot'
      )
    ).toBe(false);

    const replacement = await connect();
    const resumed = await replacement.join(
      'different-untrusted-id',
      800,
      String(joined['resumeToken'])
    );
    expect(resumed).toMatchObject({
      id: 'pilot',
      resumeToken: joined['resumeToken'],
    });
    expect(entity(await replacement.state(), 'pilot').playerMotion).toMatchObject({
      mode: 'free',
      epoch: 1,
      ack: 0,
    });
    expect(engine.getPlayer('pilot')?.position).toEqual({ x: 100, y: 0 });
  });

  it('rejects a valid resume token on a socket already bound to another current pilot', async () => {
    const { joined, engine } = await world();
    const other = await connect();
    await other.join('other', -900);
    const otherServerSocket = engine.getPlayer('other')?.ws;
    const pilotServerSocket = engine.getPlayer('pilot')?.ws;
    expect(otherServerSocket).toBeDefined();
    expect(pilotServerSocket).toBeDefined();

    const after = other.messages.length;
    other.send('join', {
      id: 'forged-id',
      name: 'forged-id',
      position: { x: 800, y: 0 },
      snapshotVersion: 1,
      asteroidInteractions: 1,
      resumeToken: joined['resumeToken'],
    });
    const error = await other.waitFor(
      () =>
        other.messages
          .slice(after)
          .find(
            (message) =>
              message.type === 'error' && String(message.data).includes('dedicated gameplay socket')
          ),
      'current socket resume rejection'
    );
    expect(error.type).toBe('error');
    expect(other.messages.slice(after).some((message) => message.type === 'joined')).toBe(false);
    expect(engine.getPlayer('other')?.ws).toBe(otherServerSocket);
    expect(engine.getPlayer('pilot')?.ws).toBe(pilotServerSocket);
  });

  it('applies a valid pose only from the owning socket and acknowledges its sequence', async () => {
    const { pilot, observer, engine } = await world();
    const initial = entity(await pilot.state(), 'pilot');
    const epoch = initial.playerMotion?.epoch;
    expect(epoch).toBe(1);
    const initialPosition = { ...initial.position };

    observer.send('update', {
      id: 'pilot',
      motionEpoch: epoch,
      motionSequence: 1,
      position: { x: initialPosition.x + 1, y: initialPosition.y },
      velocity: { x: 0, y: 0 },
      angle: 0,
      thrusting: false,
    });
    await observer.barrier();
    expect(entity(await pilot.state(), 'pilot').position).toEqual(initialPosition);

    pilot.send('update', {
      id: 'pilot',
      motionEpoch: epoch,
      motionSequence: 1,
      position: { x: initialPosition.x + 1, y: initialPosition.y },
      velocity: { x: 0, y: 0 },
      angle: 0,
      thrusting: false,
    });
    expect(entity(await pilot.state(), 'pilot').playerMotion).toMatchObject({
      mode: 'free',
      epoch,
      ack: 1,
    });
    expect(engine.getPlayer('pilot')?.position).toEqual({
      x: initialPosition.x + 1,
      y: initialPosition.y,
    });

    pilot.send('update', {
      id: 'pilot',
      motionEpoch: epoch,
      motionSequence: 1,
      position: { x: initialPosition.x + 2, y: initialPosition.y },
      velocity: { x: 0, y: 0 },
      angle: 0,
      thrusting: false,
    });
    await pilot.barrier();
    expect(entity(await pilot.state(), 'pilot').position).toEqual({
      x: initialPosition.x + 1,
      y: initialPosition.y,
    });
  });

  it('preserves a disconnected pilot after grace, rotates its token, and retires the old token', async () => {
    const { pilot, observer, joined, engine } = await world();
    const token = String(joined['resumeToken']);
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    engine.startGameLoop();
    await pilot.close();
    await observer.waitFor(
      () => {
        const state = observer.snapshots.at(-1);
        return state && !state.entities.some((row) => row.id === 'pilot') ? state : undefined;
      },
      'observer sees grace expiry removal',
      3500
    );
    expect(
      observer.messages.some(
        (message) =>
          message.type === 'playerLeft' && isRecord(message.data) && message.data['id'] === 'pilot'
      )
    ).toBe(true);

    const replacement = await connect();
    const resumed = await replacement.join('expired', 100, token);
    expect(resumed).toMatchObject({ id: 'pilot' });
    expect(resumed['resumeToken']).toMatch(/^[a-f0-9]{64}$/);
    expect(resumed['resumeToken']).not.toBe(token);
    expect(engine.getPlayer('expired')).toBeUndefined();
    expect(entity(await replacement.state(), 'pilot').playerMotion).toMatchObject({
      mode: 'free',
      epoch: 1,
    });

    const retired = await connect();
    retired.send('join', {
      id: 'retired',
      name: 'retired',
      position: { x: 100, y: 0 },
      kitId: 'hauler',
      snapshotVersion: 1,
      asteroidInteractions: 1,
      resumeToken: token,
    });
    await retired.waitFor(
      () => retired.messages.find((message) => message.type === 'sessionExpired'),
      'retired token rejection after archived resume'
    );
    expect(retired.messages.some((message) => message.type === 'joined')).toBe(false);
  });

  it('preserves a pilot after explicit leave, rotates its token, and retires the old token', async () => {
    const { pilot, observer, joined, engine } = await world();
    const token = String(joined['resumeToken']);
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    pilot.send('leave');
    expect((await observer.state()).entities.some((row) => row.id === 'pilot')).toBe(false);
    expect(engine.getPlayerCount()).toBe(1);

    const replacement = await connect();
    const resumed = await replacement.join('pilot', 100, token);
    expect(resumed).toMatchObject({ id: 'pilot' });
    expect(resumed['resumeToken']).toMatch(/^[a-f0-9]{64}$/);
    expect(resumed['resumeToken']).not.toBe(token);
    expect(engine.getPlayerCount()).toBe(2);

    const retired = await connect();
    retired.send('join', {
      id: 'retired',
      name: 'retired',
      position: { x: 100, y: 0 },
      kitId: 'hauler',
      snapshotVersion: 1,
      asteroidInteractions: 1,
      resumeToken: token,
    });
    await retired.waitFor(
      () => retired.messages.find((message) => message.type === 'sessionExpired'),
      'retired token rejection after explicit-leave resume'
    );
    expect(retired.messages.some((message) => message.type === 'joined')).toBe(false);
  });
});
