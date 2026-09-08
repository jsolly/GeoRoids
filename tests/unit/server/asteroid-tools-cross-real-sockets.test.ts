import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createServerInstance } from '../../../server/createServer';
import { ASTEROID_MOTION } from '../../../shared/asteroidMotion';
import { SnapshotDecoder } from '../../../shared/snapshotProtocol';
import type { AsteroidData, ServerEntityData, ServerGameSnapshot } from '../../../shared-types';

interface Packet {
  type: string;
  data?: Record<string, unknown>;
}

class PilotSocket {
  readonly messages: Packet[] = [];
  readonly snapshots: ServerGameSnapshot[] = [];
  readonly failures: Error[] = [];
  private readonly decoder = new SnapshotDecoder();

  constructor(readonly ws: WebSocket) {
    ws.on('error', (error) => this.failures.push(error));
    ws.on('message', (raw) => {
      try {
        const packet = JSON.parse(String(raw)) as Packet;
        this.messages.push(packet);
        if (packet.type === 'joined') {
          this.decoder.reset();
        }
        if (packet.type === 'snapshot') {
          this.snapshots.push(this.decoder.decode(packet.data));
        }
      } catch (error) {
        this.failures.push(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  send(type: string, data: Record<string, unknown> = {}): void {
    this.ws.send(JSON.stringify({ type, data }));
  }

  async waitFor<T>(read: () => T | undefined, label: string, timeout = 2500): Promise<T> {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
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
    const pong = once(this.ws, 'pong');
    this.ws.ping();
    await pong;
  }

  async state(): Promise<ServerGameSnapshot> {
    // A TCP ping proves earlier command frames reached their handlers. The next
    // snapshot must be later than that barrier, not an already queued old row.
    await this.barrier();
    const after = this.snapshots.length;
    this.send('snapshotResync');
    return this.waitFor(() => this.snapshots[after], 'post-command decoded snapshot');
  }

  async join(
    id: string,
    x: number,
    factionId = 'ion',
    resumeToken?: string
  ): Promise<Record<string, unknown>> {
    const after = this.messages.length;
    this.send('join', {
      id,
      name: id,
      position: { x, y: 0 },
      kitId: 'hauler',
      factionId,
      snapshotVersion: 1,
      asteroidInteractions: 1,
      ...(resumeToken ? { resumeToken } : {}),
    });
    return this.waitFor(
      () => this.messages.slice(after).find((message) => message.type === 'joined')?.data,
      `join ${id}`
    );
  }

  async joinLegacy(id: string, x: number): Promise<Record<string, unknown>> {
    const after = this.messages.length;
    this.send('join', {
      id,
      name: id,
      position: { x, y: 0 },
    });
    return this.waitFor(
      () => this.messages.slice(after).find((message) => message.type === 'joined')?.data,
      `legacy join ${id}`
    );
  }

  async close(): Promise<void> {
    if (this.ws.readyState === WebSocket.CLOSED) {
      return;
    }
    const closed = once(this.ws, 'close');
    this.ws.close();
    await closed;
  }
}

let server: ReturnType<typeof createServerInstance> | undefined;
const clients: PilotSocket[] = [];

async function connect(): Promise<PilotSocket> {
  if (!server) {
    throw new Error('Server missing');
  }
  const client = new PilotSocket(new WebSocket(`ws://127.0.0.1:${await server.listening}/ws`));
  clients.push(client);
  await once(client.ws, 'open');
  return client;
}

function rock(id: string, x: number, omega = 0): AsteroidData {
  return {
    id,
    position: { x, y: 0 },
    velocity: { x: 0, y: 0 },
    size: 40,
    jaggedness: 0,
    rotation: Math.PI / 4,
    angularVelocity: omega,
    health: 500,
    maxHealth: 500,
    vertices: 4,
    offsets: [1, 1, 1, 1],
    material: 'metal',
  };
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
  const joined = await pilot.join('hauler', 100);
  const observer = await connect();
  await observer.join('observer', observerX, 'ember');
  // Existing authoritative add/remove seams isolate the world; no service state,
  // handler mocks, snapshot fabrication, or new test-control endpoints are used.
  for (const bot of server.gameEngine.getAllBots()) {
    server.gameEngine.removeBot(bot.id);
  }
  for (const asteroid of server.gameEngine.getAllAsteroids()) {
    server.gameEngine.removeAsteroid(asteroid.id);
  }
  server.gameEngine.addAsteroid(rock('spinner', 0, 0.05));
  server.gameEngine.addAsteroid(rock('mark', 190));
  server.gameEngine.addAsteroid(rock('distant', -700));
  return { pilot, observer, joined, engine: server.gameEngine };
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await server?.close();
  server = undefined;
});

describe('Enhanced asteroid tools cross real gameplay WebSockets', () => {
  it('retains the visible same-epoch latch through a physical flap and accepts its private token', async () => {
    const { pilot, observer, joined, engine } = await world();
    expect(joined['snapshotVersion']).toBe(1);
    expect(joined['asteroidInteractions']).toBe(1);
    expect(joined['resumeToken']).toMatch(/^[a-f0-9]{64}$/);
    pilot.send('asteroidTool', { action: 'latch', targetId: 'spinner', sequence: 0 });
    const latched = entity(await pilot.state(), 'hauler');
    expect(latched.asteroidMotion?.mode).toBe('latched');
    const epoch = latched.asteroidMotion?.epoch;
    expect(JSON.stringify(await observer.state())).not.toContain(String(joined['resumeToken']));
    await pilot.close();
    const duringGrace = await observer.state();
    expect(duringGrace.entities.find((row) => row.id === 'hauler')?.asteroidMotion).toMatchObject({
      mode: 'latched',
      epoch,
    });
    expect(
      observer.messages.some(
        (message) => message.type === 'playerLeft' && message.data?.['id'] === 'hauler'
      )
    ).toBe(false);
    engine.startGameLoop();
    const replacement = await connect();
    const resumed = await replacement.join(
      'different-untrusted-id',
      800,
      'ember',
      String(joined['resumeToken'])
    );
    expect(resumed['id']).toBe('hauler');
    expect(resumed['factionId']).toBe('ion');
    expect(resumed['resumeToken']).toBe(joined['resumeToken']);
    const restored = entity(await replacement.state(), 'hauler');
    expect(restored.asteroidMotion).toMatchObject({
      mode: 'latched',
      epoch,
      asteroidId: 'spinner',
    });
    expect(restored.position).not.toEqual({ x: 800, y: 0 });
    expect(engine.getPlayerCount()).toBe(2);
  });

  it('rejects a valid enhanced resume token on a socket already bound to a legacy pilot', async () => {
    const { joined, engine } = await world();
    const legacy = await connect();
    await legacy.joinLegacy('legacy', -900);
    // `pilot.ws`/`legacy.ws` are the client-side WebSocket wrappers. The
    // server stores the accepted connection object separately, so preserve
    // those server-side references before attempting the forged resume.
    const legacyServerSocket = engine.getPlayer('legacy')?.ws;
    const haulerServerSocket = engine.getPlayer('hauler')?.ws;
    expect(legacyServerSocket).toBeDefined();
    expect(haulerServerSocket).toBeDefined();

    const after = legacy.messages.length;
    legacy.send('join', {
      id: 'forged-id',
      name: 'forged-id',
      position: { x: 800, y: 0 },
      snapshotVersion: 1,
      asteroidInteractions: 1,
      resumeToken: joined['resumeToken'],
    });
    const error = await legacy.waitFor(
      () =>
        legacy.messages
          .slice(after)
          .find(
            (message) =>
              message.type === 'error' && String(message.data).includes('dedicated gameplay socket')
          ),
      'legacy socket resume rejection'
    );
    expect(error.type).toBe('error');
    expect(legacy.messages.slice(after).some((message) => message.type === 'joined')).toBe(false);
    expect(engine.getPlayer('legacy')?.ws).toBe(legacyServerSocket);
    expect(engine.getPlayer('hauler')?.ws).toBe(haulerServerSocket);
  });

  it('applies input spam only on a simulation tick, preserves pending input across same-socket join, and hands released motion back by epoch', async () => {
    const { pilot, observer, joined, engine } = await world(-100);
    pilot.send('asteroidTool', { action: 'latch', targetId: 'spinner', sequence: 0 });
    const latched = entity(await pilot.state(), 'hauler');
    const epoch = latched.asteroidMotion?.epoch;
    expect(epoch).toBe(2);
    const initialPosition = { ...latched.position };
    const initialFuel = latched.fuel;
    if (initialFuel === undefined) {
      throw new Error('Authoritative fuel absent');
    }
    const stalePose = {
      id: 'hauler',
      motionEpoch: 1,
      motionSequence: 500,
      position: { x: 900, y: 900 },
      velocity: { x: 0, y: 0 },
      angle: 0,
      thrusting: false,
    };
    pilot.send('update', stalePose);
    observer.send('update', { ...stalePose, motionEpoch: epoch });
    observer.send('asteroidTool', { action: 'latch', targetId: 'spinner', sequence: 0 });
    for (let sequence = 0; sequence < 100; sequence += 1) {
      pilot.send('asteroidInput', {
        epoch,
        sequence,
        thrust: true,
        turn: 0,
        aimAngle: -Math.PI / 2,
      });
    }
    const beforeTick = entity(await pilot.state(), 'hauler');
    expect(beforeTick.position).toEqual(initialPosition);
    expect(beforeTick.fuel).toBe(initialFuel);
    expect(beforeTick.asteroidMotion?.ack).toBe(0);
    expect(entity(await observer.state(), 'observer').asteroidMotion?.mode).toBe('free');
    await pilot.join('hauler', 100, 'ion', String(joined['resumeToken']));
    engine.advanceOneFrame();
    const applied = entity(await pilot.state(), 'hauler');
    expect(applied.asteroidMotion).toMatchObject({ epoch, mode: 'latched', ack: 99 });
    expect(applied.position).not.toEqual(initialPosition);
    expect(applied.fuel).toBeLessThan(initialFuel);
    expect(initialFuel - (applied.fuel ?? 0)).toBeLessThanOrEqual(
      ASTEROID_MOTION.fuelPerFrame * ASTEROID_MOTION.maxFramesPerStep + 1e-8
    );
    expect(entity(await observer.state(), 'hauler').position).toEqual(applied.position);

    // Replaying an already accepted sequence cannot attach a new action to it.
    pilot.send('asteroidInput', {
      epoch,
      sequence: 99,
      thrust: false,
      turn: 0,
      aimAngle: 0,
      action: 'release',
    });
    await pilot.barrier();
    engine.advanceOneFrame();
    expect(entity(await pilot.state(), 'hauler').asteroidMotion?.mode).toBe('latched');
    pilot.send('asteroidInput', {
      epoch,
      sequence: 100,
      thrust: false,
      turn: 0,
      aimAngle: 0,
      action: 'release',
    });
    await pilot.barrier();
    engine.advanceOneFrame();
    const released = entity(await pilot.state(), 'hauler');
    expect(released.asteroidMotion).toMatchObject({ epoch, mode: 'released', ack: 100 });
    expect(released.harpoonTargetId).toBeUndefined();
    expect(Math.hypot(released.velocity.x, released.velocity.y)).toBeGreaterThan(0);
    pilot.send('update', stalePose);
    expect(entity(await pilot.state(), 'hauler').position).toEqual(released.position);

    engine.startGameLoop();
    const handoff = await pilot.waitFor(() => {
      const row = pilot.snapshots.at(-1)?.entities.find((item) => item.id === 'hauler');
      return row?.asteroidMotion?.mode === 'handoff' ? row : undefined;
    }, 'released motion reaches a handoff anchor');
    engine.stopGameLoop();
    expect(handoff.asteroidMotion?.epoch).toBeGreaterThan(epoch ?? 0);
    pilot.send('update', { ...stalePose, position: handoff.position });
    expect(entity(await pilot.state(), 'hauler').asteroidMotion?.mode).toBe('handoff');
    const acceptedPose = { x: handoff.position.x + 1, y: handoff.position.y };
    pilot.send('update', {
      ...stalePose,
      motionEpoch: handoff.asteroidMotion?.epoch,
      motionSequence: 101,
      position: acceptedPose,
    });
    const free = entity(await pilot.state(), 'hauler');
    expect(free.asteroidMotion).toMatchObject({
      mode: 'free',
      epoch: handoff.asteroidMotion?.epoch,
      ack: 101,
    });
    expect(free.position).toEqual(acceptedPose);
    pilot.send('update', {
      ...stalePose,
      motionEpoch: free.asteroidMotion?.epoch,
      motionSequence: 102,
      position: { x: acceptedPose.x + 1, y: acceptedPose.y },
    });
    const ordinaryPosition = { x: acceptedPose.x + 1, y: acceptedPose.y };
    expect(entity(await observer.state(), 'hauler').position).toEqual(ordinaryPosition);
    // This forged update would fit the target's epoch, speed and distance budget;
    // only ownership of the physical socket can reject it.
    observer.send('update', {
      ...stalePose,
      motionEpoch: free.asteroidMotion?.epoch,
      motionSequence: 103,
      position: { x: ordinaryPosition.x + 1, y: ordinaryPosition.y },
    });
    expect(entity(await pilot.state(), 'hauler').position).toEqual(ordinaryPosition);
    pilot.send('update', {
      ...stalePose,
      motionEpoch: free.asteroidMotion?.epoch,
      motionSequence: 103,
    });
    expect(entity(await pilot.state(), 'hauler').position).toEqual(ordinaryPosition);
    pilot.send('update', {
      ...stalePose,
      motionEpoch: free.asteroidMotion?.epoch,
      motionSequence: 102,
      position: { x: ordinaryPosition.x + 1, y: ordinaryPosition.y },
    });
    expect(entity(await pilot.state(), 'hauler').position).toEqual(ordinaryPosition);
  });

  it('attaches only a nearby physical payload and publishes actual two-rock momentum before releasing it', async () => {
    const { pilot, observer, engine } = await world();
    pilot.send('asteroidTool', { action: 'latch', targetId: 'spinner', sequence: 0 });
    const epoch = entity(await pilot.state(), 'hauler').asteroidMotion?.epoch;
    pilot.send('asteroidInput', {
      epoch,
      sequence: 0,
      thrust: false,
      turn: 0,
      aimAngle: 0,
      action: 'anchor',
      targetId: 'distant',
    });
    await pilot.barrier();
    engine.advanceOneFrame();
    expect(entity(await pilot.state(), 'hauler').asteroidMotion?.payloadId).toBeUndefined();
    pilot.send('asteroidInput', {
      epoch,
      sequence: 0,
      thrust: false,
      turn: 0,
      aimAngle: 0,
      action: 'anchor',
      targetId: 'mark',
    });
    await pilot.barrier();
    engine.advanceOneFrame();
    const anchored = await observer.state();
    expect(entity(anchored, 'hauler').asteroidMotion).toMatchObject({
      payloadId: 'mark',
      tetherMode: 'anchor',
      ack: 0,
    });
    const payload = anchored.asteroids.find((item) => item.id === 'mark');
    expect(payload).toBeDefined();
    expect(Math.hypot(payload?.velocity.x ?? 0, payload?.velocity.y ?? 0)).toBeGreaterThan(0);
    pilot.send('asteroidInput', {
      epoch,
      sequence: 1,
      thrust: false,
      turn: 0,
      aimAngle: 0,
      action: 'release',
    });
    await pilot.barrier();
    engine.advanceOneFrame();
    const released = await observer.state();
    expect(entity(released, 'hauler').asteroidMotion?.payloadId).toBeUndefined();
    expect(released.asteroids.find((item) => item.id === 'mark')?.health).toBeGreaterThan(0);
    expect(released.asteroids.find((item) => item.id === 'mark')?.position).not.toEqual(
      payload?.position
    );
  });

  it('expires a disconnected attachment after two seconds and rejects its token before allowing a fresh free session', async () => {
    const { pilot, observer, joined, engine } = await world();
    pilot.send('asteroidTool', { action: 'latch', targetId: 'spinner', sequence: 0 });
    expect(entity(await pilot.state(), 'hauler').asteroidMotion?.mode).toBe('latched');
    engine.startGameLoop();
    await pilot.close();
    const closedAt = Date.now();
    expect((await observer.state()).entities.some((row) => row.id === 'hauler')).toBe(true);
    await observer.waitFor(
      () => {
        const state = observer.snapshots.at(-1);
        return state && !state.entities.some((row) => row.id === 'hauler') ? state : undefined;
      },
      'observer sees grace expiry removal',
      3500
    );
    expect(Date.now() - closedAt).toBeGreaterThanOrEqual(ASTEROID_MOTION.reconnectGraceMs - 30);
    expect(observer.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'playerLeft', data: { id: 'hauler' } }),
      ])
    );
    const replacement = await connect();
    replacement.send('join', {
      id: 'hauler',
      name: 'hauler',
      snapshotVersion: 1,
      asteroidInteractions: 1,
      resumeToken: joined['resumeToken'],
    });
    await replacement.waitFor(
      () => replacement.messages.find((message) => message.type === 'sessionExpired'),
      'expired token rejection'
    );
    expect(replacement.messages.some((message) => message.type === 'joined')).toBe(false);
    const fresh = await replacement.join('hauler', 100);
    expect(fresh['resumeToken']).not.toBe(joined['resumeToken']);
    expect(entity(await replacement.state(), 'hauler').asteroidMotion).toMatchObject({
      mode: 'free',
      epoch: 1,
    });
    expect(entity(await observer.state(), 'hauler').harpoonTargetId).toBeUndefined();
  });

  it('atomically supersedes an active socket and invalidates its private token on explicit leave', async () => {
    const { pilot, observer, joined, engine } = await world();
    pilot.send('asteroidTool', { action: 'latch', targetId: 'spinner', sequence: 0 });
    const epoch = entity(await pilot.state(), 'hauler').asteroidMotion?.epoch;
    const replacement = await connect();
    const superseded = once(pilot.ws, 'close');
    await replacement.join('forged-id', 800, 'ember', String(joined['resumeToken']));
    const [closeCode] = await superseded;
    expect(closeCode).toBe(4001);
    expect(engine.getPlayerCount()).toBe(2);
    expect(entity(await observer.state(), 'hauler').asteroidMotion).toMatchObject({
      mode: 'latched',
      epoch,
    });
    expect(
      observer.messages.some(
        (message) => message.type === 'playerLeft' && message.data?.['id'] === 'hauler'
      )
    ).toBe(false);
    replacement.send('leave');
    expect((await observer.state()).entities.some((row) => row.id === 'hauler')).toBe(false);
    expect(engine.getPlayerCount()).toBe(1);
    expect(observer.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'playerLeft', data: { id: 'hauler' } }),
      ])
    );
    const after = replacement.messages.length;
    replacement.send('join', {
      id: 'hauler',
      name: 'hauler',
      snapshotVersion: 1,
      asteroidInteractions: 1,
      resumeToken: joined['resumeToken'],
    });
    await replacement.waitFor(
      () => replacement.messages.slice(after).find((message) => message.type === 'sessionExpired'),
      'explicit leave invalidates token immediately'
    );
    expect(replacement.messages.slice(after).some((message) => message.type === 'joined')).toBe(
      false
    );
  });
});
