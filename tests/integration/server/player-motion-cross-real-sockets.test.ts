/* @vitest-environment node */
import { afterEach, describe, expect, it as test } from 'vitest';
import { WebSocket } from 'ws';
import { createServerInstance } from '../../../server/createServer';
import { SNAPSHOT_VERSION, SnapshotDecoder } from '../../../shared/snapshotProtocol';
import { WORLD } from '../../../shared/world';
import type { ServerEntityData, ServerGameSnapshot } from '../../../shared-types';
import { closePlayerMotionScenario } from '../../support/playerMotionCleanup';
import { WireClient } from '../../support/wireClient';

const RESUME_TOKEN_PATTERN = /^[a-f0-9]{64}$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

class PilotSocket {
  readonly messages: WireClient['messages'];
  private readonly wire: WireClient;
  readonly snapshots: ServerGameSnapshot[] = [];
  private readonly decoder = new SnapshotDecoder();

  constructor(readonly ws: WebSocket) {
    this.wire = new WireClient(ws);
    this.messages = this.wire.messages;
    ws.on('message', (raw) => {
      try {
        const text = String(raw);
        const result = this.decoder.readMessage(text, { acceptSnapshots: true });
        if (result.kind === 'snapshot-rejected') {
          throw result.error;
        }
        if (result.kind === 'snapshot') {
          this.snapshots.push(result.state);
          if (this.ws.readyState === WebSocket.OPEN) {
            this.send('snapshotAck', { sequence: result.metadata.sequence });
          }
          return;
        }
        if (!isRecord(result.message) || typeof result.message['type'] !== 'string') {
          throw new Error('Server packet is missing its type');
        }
        if (result.message['type'] === 'joined') {
          this.decoder.reset();
        }
      } catch (error) {
        this.wire.failures.push(
          error instanceof Error
            ? error
            : new Error(typeof error === 'string' ? error : JSON.stringify(error), { cause: error })
        );
      }
    });
  }

  send(type: string, data: Record<string, unknown> = {}): void {
    this.wire.send({ type, data });
  }

  waitFor<T>(read: () => T | undefined, label: string, timeout = 2500): Promise<T> {
    return this.wire.waitFor(read, label, timeout);
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

  join(id: string, x: number, resumeToken?: string): Promise<Record<string, unknown>> {
    const after = this.messages.length;
    this.send('join', {
      id,
      name: id,
      position: { x, y: 0 },
      kitId: 'hauler',
      snapshotVersion: SNAPSHOT_VERSION,
      asteroidInteractions: 1,
      ...(resumeToken != null && resumeToken !== '' ? { resumeToken } : {}),
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
    this.wire.assertHealthy();
  }
}

let server: ReturnType<typeof createServerInstance> | undefined;
const clients: PilotSocket[] = [];

async function connect(): Promise<PilotSocket> {
  if (!server) {
    throw new Error('Server missing');
  }
  const client = new PilotSocket(
    new WebSocket(
      `ws://127.0.0.1:${await server.listening}/ws?snapshotVersion=${SNAPSHOT_VERSION}&asteroidInteractions=1`
    )
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
  try {
    await closePlayerMotionScenario({ clients, server });
  } finally {
    clients.length = 0;
    server = undefined;
  }
});

describe('Enhanced player motion cross real gameplay WebSockets', () => {
  test('joining receives nearby asteroids before resync and retired initialization cannot interrupt play', async () => {
    server = createServerInstance({ port: 0, nodeEnv: 'test' });
    await server.listening;
    server.gameEngine.stopGameLoop();
    const pilot = await connect();
    await pilot.join('baseline-pilot', 100);
    const initial = await pilot.waitFor(() => pilot.snapshots[0], 'unsolicited join baseline');
    const ship = entity(initial, 'baseline-pilot');
    expect(initial.asteroids.length).toBeGreaterThan(0);
    for (const rock of initial.asteroids) {
      expect(
        Math.hypot(rock.position.x - ship.position.x, rock.position.y - ship.position.y)
      ).toBeLessThanOrEqual(WORLD.asteroidInterestRadius);
    }
    expect(pilot.messages[0]?.type).toBe('joined');
    expect(pilot.messages.some((message) => message.type === 'asteroidCreateBatch')).toBe(false);

    pilot.send('initAsteroids', { id: 'baseline-pilot' });
    await pilot.waitFor(
      () => pilot.messages.find((message) => message.type === 'error'),
      'retired command rejection'
    );
    expect(pilot.ws.readyState).toBe(WebSocket.OPEN);
    const recovered = await pilot.state();
    expect(entity(recovered, 'baseline-pilot').id).toBe('baseline-pilot');
    expect(recovered.asteroids.map((rock) => rock.id)).toEqual(
      initial.asteroids.map((rock) => rock.id)
    );
  });

  test('publishes a correction after rejected movement and accepts the recovered pilot', async () => {
    const { pilot, observer } = await world();
    const initial = entity(await pilot.state(), 'pilot');
    const epoch = initial.playerMotion?.epoch;
    const pose = {
      id: 'pilot',
      motionEpoch: epoch,
      motionSequence: 1,
      position: { x: initial.position.x + 1000, y: initial.position.y },
      velocity: { x: 0, y: 0 },
      angle: 0,
      thrusting: false,
    };
    pilot.send('update', pose);
    const correction = entity(await pilot.state(), 'pilot');
    expect(correction.position).toEqual(initial.position);
    expect(correction.playerMotion).toMatchObject({ mode: 'handoff', epoch: (epoch ?? 0) + 1 });
    pilot.send('update', { ...pose, motionSequence: 2 });
    expect(entity(await pilot.state(), 'pilot').playerMotion).toEqual(correction.playerMotion);
    pilot.send('update', {
      ...pose,
      motionEpoch: correction.playerMotion?.epoch,
      position: correction.position,
    });
    const recovered = entity(await pilot.state(), 'pilot');
    expect(recovered.playerMotion).toMatchObject({ mode: 'free', ack: 1 });
    expect(entity(await observer.state(), 'pilot').playerMotion).toEqual(recovered.playerMotion);
  });

  test('rejects a valid resume token on a socket already bound to another current pilot', async () => {
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
      snapshotVersion: SNAPSHOT_VERSION,
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

  test('applies a valid pose only from the owning socket and acknowledges its sequence', async () => {
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

  test('preserves a pilot after explicit leave, rotates its token, and retires the old token', async () => {
    const { pilot, observer, joined, engine } = await world();
    const token = String(joined['resumeToken']);
    expect(token).toMatch(RESUME_TOKEN_PATTERN);
    pilot.send('leave');
    expect((await observer.state()).entities.some((row) => row.id === 'pilot')).toBe(false);
    expect(engine.getPlayerCount()).toBe(1);

    const replacement = await connect();
    const resumed = await replacement.join('pilot', 100, token);
    expect(resumed).toMatchObject({ id: 'pilot' });
    expect(resumed['resumeToken']).toMatch(RESUME_TOKEN_PATTERN);
    expect(resumed['resumeToken']).not.toBe(token);
    expect(engine.getPlayerCount()).toBe(2);

    const retired = await connect();
    retired.send('join', {
      id: 'retired',
      name: 'retired',
      position: { x: 100, y: 0 },
      kitId: 'hauler',
      snapshotVersion: SNAPSHOT_VERSION,
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

test('shield commands require the owning socket and cooldown survives a real reconnect', async () => {
  const { pilot, observer, joined, engine } = await world();
  observer.send('activateShield', { id: 'pilot' });
  await observer.barrier();
  expect(entity(await pilot.state(), 'pilot').shieldFrames).toBe(0);
  pilot.send('activateShield', { id: 'pilot' });
  const active = entity(await pilot.state(), 'pilot');
  expect(active.shieldFrames).toBe(120);
  expect(active.shieldCooldownFrames).toBe(720);
  const actor = engine.getPlayer('pilot');
  if (!actor) {
    throw new Error('Missing shield pilot');
  }
  actor.cargo = 100;
  delete actor.spawnProtectionTimer;
  const protectedHealth = actor.health;
  expect(engine.handleShipDamage('pilot', 'asteroid', 30).applied).toBe(false);
  expect(actor.cargo).toBe(100);
  expect(actor.health).toBe(protectedHealth);
  pilot.send('activateShield', { id: 'pilot' });
  expect(entity(await pilot.state(), 'pilot').shieldCooldownFrames).toBe(720);
  pilot.send('leave');
  await pilot.barrier();
  await pilot.close();
  const replacement = await connect();
  await replacement.join('pilot', 100, String(joined['resumeToken']));
  const recovered = entity(await replacement.state(), 'pilot');
  expect(recovered.shieldCooldownFrames).toBeGreaterThan(0);
  expect(recovered.shieldCooldownFrames).toBeLessThanOrEqual(720);
  replacement.send('activateShield', { id: 'pilot' });
  await replacement.barrier();
  expect(engine.getPlayer('pilot')?.shieldCooldownFrames).toBe(recovered.shieldCooldownFrames);
});
