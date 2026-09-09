import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { AsteroidMotionService } from '../../../server/core/AsteroidMotionService';
import { EntityManager } from '../../../server/core/EntityManager';
import { RNGService } from '../../../server/core/RNGService';
import {
  ASTEROID_MOTION,
  asteroidInertia,
  asteroidMass,
  coupleAsteroidMomentum,
} from '../../../shared/asteroidMotion';
import { radiusFromMass } from '../../../shared/shipGrowth';
import type { AsteroidData, AsteroidMotionInput } from '../../../shared-types';
import { GAME, ROID } from '../../../src/constants';
import { Ship } from '../../../src/entities/ship/Ship';
import { getAsteroidFieldRadius } from '../../../src/physics/asteroidMotion';
import { getGameBoundary } from '../../../src/physics/boundary';
import { sampleGradient } from '../../../src/physics/terrain/heightfield';
import { getTerrainField } from '../../../src/physics/terrain/terrainSession';

let server: WebSocketServer;
const peers: WebSocket[] = [];
const clients: WebSocket[] = [];

beforeAll(async () => {
  server = new WebSocketServer({ port: 0 });
  server.on('connection', (socket) => peers.push(socket));
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  for (let index = 0; index < 3; index += 1) {
    const client = new WebSocket(`ws://127.0.0.1:${port}`);
    clients.push(client);
    await once(client, 'open');
  }
});

afterAll(async () => {
  await Promise.all(
    clients.map(async (client) => {
      const closed = once(client, 'close');
      client.close();
      await closed;
    })
  );
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
});

function rock(id = 'spinner', x = 0, y = 0, size = 70): AsteroidData {
  return {
    id,
    position: { x, y },
    velocity: { x: 0, y: 0 },
    size,
    jaggedness: 0,
    rotation: Math.PI / 4,
    angularVelocity: 0.16,
    health: 100,
    maxHealth: 100,
    vertices: 4,
    offsets: [1, 1, 1, 1],
    material: 'metal',
    spinClass: 'natural',
  };
}

function fixture() {
  const socket = peers[0];
  const second = peers[1];
  const third = peers[2];
  if (!socket || !second || !third) {
    throw new Error('Actual WebSocket peers are missing');
  }
  const entities = new EntityManager(new RNGService(1));
  const actor = entities.addHumanPlayer(
    'hauler',
    'Hauler',
    socket,
    { x: 100, y: 0 },
    undefined,
    'hauler',
    'ion'
  );
  actor.asteroidInteractions = 1;
  actor.spawnProtectionTimer = 0;
  delete actor.respawnTimer;
  actor.abilityCooldownFrames = 0;
  const service = new AsteroidMotionService();
  const registered = service.register(actor, socket, 1, 0);
  if (!registered.ok) {
    throw new Error(registered.error);
  }
  return {
    service,
    actor,
    socket,
    second,
    third,
    token: registered.resumeToken,
    entities,
    field: [rock()],
  };
}

function input(
  epoch: number,
  sequence: number,
  extra: Partial<AsteroidMotionInput> = {}
): AsteroidMotionInput {
  return { epoch, sequence, thrust: false, turn: 0, aimAngle: 0, ...extra };
}

function latch(f: ReturnType<typeof fixture>) {
  expect(
    f.service.latch(f.socket, { action: 'latch', targetId: 'spinner', sequence: 0 }, f.field, 0)
  ).toEqual({ ok: true });
  const epoch = f.service.getState(f.actor.id)?.epoch;
  if (epoch === undefined) {
    throw new Error('Latch epoch missing');
  }
  return epoch;
}

describe('Haulers own a physical slingshot through delayed messages and transport flaps', () => {
  it('requires negotiated capability and exact authoritative socket identity', () => {
    const f = fixture();
    const other = f.entities.addHumanPlayer(
      'other',
      'Other',
      f.third,
      { x: 0, y: 0 },
      undefined,
      'hauler',
      'ember'
    );
    other.asteroidInteractions = 1;
    expect(f.service.register(other, f.third, 0, 0).ok).toBe(false);
    expect(f.service.register(other, f.second, 1, 0).ok).toBe(false);
    other.health = 0;
    expect(f.service.register(other, f.third, 1, 0).ok).toBe(false);
    expect(f.service.input(f.second, input(1, 0), f.field, 1).ok).toBe(false);
    expect(f.actor.asteroidMotion).not.toHaveProperty('resumeToken');
    expect(f.service.getState(f.actor.id)).not.toHaveProperty('token');
  });

  it('latches the rendered surface, rotates the pilot, and grants a real tangential release without fuel', () => {
    const f = fixture();
    const fuel = f.actor.fuel;
    const epoch = latch(f);
    expect(f.actor.harpoonLatchPos?.x).toBeCloseTo(70 * Math.SQRT1_2, 8);
    const before = { ...f.actor.position };
    f.service.step(1000 / 60, f.field);
    expect(f.actor.position.y).not.toBeCloseTo(before.y, 5);
    expect(f.service.ownsActorMotion(f.actor.id)).toBe(true);
    expect(f.service.ownsAsteroidMotion('spinner')).toBe(true);
    expect(f.service.input(f.socket, input(epoch, 0, { action: 'release' }), f.field, 20).ok).toBe(
      true
    );
    f.service.step(1000 / 30, f.field);
    expect(f.service.getState(f.actor.id)?.mode).toBe('released');
    expect(Math.hypot(f.actor.velocity.x, f.actor.velocity.y)).toBeGreaterThan(6);
    expect(f.actor.fuel).toBe(fuel);
    expect(f.actor.harpoonTargetId).toBeUndefined();
    expect(f.service.ownsAsteroidMotion('spinner')).toBe(false);
  });

  it('charges spin from actual thrust and server fuel once per tick, regardless of input spam', () => {
    const f = fixture();
    const primary = f.field[0];
    if (!primary) {
      throw new Error('Missing spinner');
    }
    primary.angularVelocity = 0.001;
    f.actor.angle = -Math.PI / 2;
    const epoch = latch(f);
    const fuel = f.actor.fuel;
    const omega = primary.angularVelocity;
    for (let sequence = 0; sequence < 100; sequence += 1) {
      expect(
        f.service.input(
          f.socket,
          input(epoch, sequence, { thrust: true, aimAngle: -Math.PI / 2 }),
          f.field,
          1
        ).ok
      ).toBe(true);
    }
    expect(f.actor.fuel).toBe(fuel);
    f.service.step(100, f.field);
    expect(f.actor.fuel).toBeCloseTo(fuel - ASTEROID_MOTION.fuelPerFrame * 6, 10);
    expect(primary.angularVelocity).toBeGreaterThan(omega);
    expect(primary.spinClass).toBe('charged');
    expect(f.service.getState(f.actor.id)?.ack).toBe(99);
    f.service.step(100, f.field);
    expect(f.actor.fuel).toBeCloseTo(fuel - ASTEROID_MOTION.fuelPerFrame * 6, 10);
  });

  it('never invents torque from an empty tank or forged client dt, force, fuel or epochs', () => {
    const f = fixture();
    f.actor.fuel = 0;
    const epoch = latch(f);
    const primary = f.field[0];
    if (!primary) {
      throw new Error('Missing spinner');
    }
    const omega = primary.angularVelocity;
    for (const forged of [
      { ...input(epoch, 0), dt: 1000 },
      { ...input(epoch, 0), torque: 999 },
      { ...input(epoch, 0), fuel: 100 },
      { ...input(epoch, 0), epoch: epoch - 1 },
      { ...input(epoch, 0), aimAngle: Infinity },
      { ...input(epoch, 0), thrust: 1 },
    ]) {
      expect(
        f.service.input(f.socket, forged as unknown as AsteroidMotionInput, f.field, 1).ok
      ).toBe(false);
    }
    expect(f.service.input(f.socket, input(epoch, 0, { thrust: true }), f.field, 1).ok).toBe(true);
    f.service.step(100, f.field);
    expect(primary.angularVelocity).toBe(omega);
    expect(f.actor.fuel).toBe(0);
    expect(f.actor.thrusting).toBe(false);
  });

  it('rejects delayed pre-latch and pre-release poses until an acknowledged handoff restores ordinary movement', () => {
    const f = fixture();
    const stale = {
      epoch: 1,
      sequence: 0,
      position: { x: 999, y: 999 },
      velocity: { x: 1, y: 0 },
      angle: 0,
      thrusting: false,
    };
    const epoch = latch(f);
    expect(f.service.acceptFreePose(f.socket, stale, 1).ok).toBe(false);
    expect(f.service.input(f.socket, input(epoch, 0, { action: 'release' }), f.field, 1).ok).toBe(
      true
    );
    f.service.step(1000 / 60, f.field);
    expect(f.service.acceptFreePose(f.socket, { ...stale, epoch }, 20).ok).toBe(false);
    let now = 1000 / 60;
    for (
      let tick = 2;
      tick < 200 && f.service.getState(f.actor.id)?.mode !== 'handoff';
      tick += 1
    ) {
      now = (tick * 1000) / 60;
      f.service.step(now, f.field);
    }
    const state = f.service.getState(f.actor.id);
    expect(state?.mode).toBe('handoff');
    expect(state?.epoch).toBeGreaterThan(epoch);
    expect(f.service.acceptFreePose(f.socket, { ...stale, epoch }, now).ok).toBe(false);
    expect(
      f.service.acceptFreePose(
        f.socket,
        {
          epoch: state?.epoch ?? -1,
          sequence: 0,
          position: { ...f.actor.position },
          velocity: { ...f.actor.velocity },
          angle: f.actor.angle,
          thrusting: false,
        },
        now
      ).ok
    ).toBe(true);
    expect(f.service.getState(f.actor.id)?.mode).toBe('free');
    expect(f.service.ownsActorMotion(f.actor.id)).toBe(false);
  });

  it('requires two distinct simulation ticks before handoff and stays authoritative without acknowledgment', () => {
    const f = fixture();
    const primary = f.field[0];
    if (!primary) {
      throw new Error('Missing spinner');
    }
    primary.angularVelocity = 0.01;
    const epoch = latch(f);
    f.service.input(f.socket, input(epoch, 0, { action: 'release' }), f.field, 0);
    f.service.step(100, f.field);
    expect(f.service.getState(f.actor.id)?.mode).toBe('released');
    f.service.step(200, f.field);
    const firstEpoch = f.service.getState(f.actor.id)?.epoch ?? -1;
    expect(f.service.getState(f.actor.id)?.mode).toBe('handoff');
    f.service.step(2300, f.field);
    expect(f.service.getState(f.actor.id)?.mode).toBe('handoff');
    expect(f.service.getState(f.actor.id)?.epoch).toBeGreaterThan(firstEpoch);
    expect(f.service.ownsActorMotion(f.actor.id)).toBe(true);
  });

  it('does not refill the free-pose lead budget on zero-time packet spam', () => {
    const f = fixture();
    let accepted = 0;
    for (let sequence = 0; sequence < 100; sequence += 1) {
      const acceptedPose = f.service.acceptFreePose(
        f.socket,
        {
          epoch: 1,
          sequence,
          position: { x: f.actor.position.x + 10, y: f.actor.position.y },
          velocity: { x: 1, y: 0 },
          angle: 0,
          thrusting: false,
        },
        0
      );
      if (acceptedPose.ok) {
        accepted += 1;
      }
    }
    expect(accepted).toBeGreaterThan(0);
    expect(accepted * 10).toBeLessThanOrEqual(6 * ASTEROID_MOTION.poseLeadFrames);
    expect(f.actor.position.x).toBeLessThanOrEqual(154);
    expect(
      f.service.acceptFreePose(
        f.socket,
        {
          epoch: 1,
          sequence: 100,
          position: { x: f.actor.position.x + 1, y: f.actor.position.y },
          velocity: { x: 100, y: 0 },
          angle: 0,
          thrusting: false,
        },
        100
      ).ok
    ).toBe(false);
  });

  it('treats an exact same-socket rejoin as idempotent without dropping pending motion or granting another owner access', () => {
    const f = fixture();
    const epoch = latch(f);
    expect(f.service.input(f.socket, input(epoch, 4, { action: 'release' }), f.field, 1).ok).toBe(
      true
    );
    const joined = f.service.resume(f.token, f.socket, 2);
    expect(joined.ok).toBe(true);
    expect(joined).not.toHaveProperty('supersededSocket');
    expect(f.service.getState(f.actor.id)?.epoch).toBe(epoch);
    expect(f.service.getState(f.actor.id)?.ack).toBe(0);
    f.service.step(1000 / 60, f.field);
    expect(f.service.getState(f.actor.id)?.mode).toBe('released');
    expect(f.service.getState(f.actor.id)?.ack).toBe(4);
    const other = f.entities.addHumanPlayer(
      'other',
      'Other',
      f.second,
      { x: 100, y: 0 },
      undefined,
      'hauler',
      'ember'
    );
    other.asteroidInteractions = 1;
    expect(f.service.register(other, f.second, 1, 20).ok).toBe(true);
    expect(f.service.resume(f.token, f.second, 21).ok).toBe(false);
    expect(f.actor.ws).toBe(f.socket);
    expect(other.ws).toBe(f.second);
  });

  it('preserves the same constrained epoch through a neutral two-second transport grace and atomically supersedes the old socket', () => {
    const f = fixture();
    const epoch = latch(f);
    const before = { ...f.actor.position };
    const fuel = f.actor.fuel;
    f.service.input(f.socket, input(epoch, 0, { thrust: true }), f.field, 1);
    expect(f.service.transportClosed(f.socket, 1)).toBe(true);
    f.service.step(100, f.field);
    expect(f.actor.position).not.toEqual(before);
    expect(f.actor.fuel).toBe(fuel);
    const resumed = f.service.resume(f.token, f.second, 100);
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) {
      throw new Error(resumed.error);
    }
    expect(resumed.actor).toBe(f.actor);
    expect(resumed.resumeToken).toBe(f.token);
    expect(f.actor.ws).toBe(f.second);
    expect(f.service.getState(f.actor.id)?.epoch).toBe(epoch);
    expect(f.service.input(f.socket, input(epoch, 1), f.field, 101).ok).toBe(false);
    expect(f.service.input(f.second, input(epoch, 1), f.field, 101).ok).toBe(true);
    const takeover = f.service.resume(f.token, f.third, 102);
    expect(takeover.ok && takeover.supersededSocket).toBe(f.second);
    expect(f.service.transportClosed(f.second, 103)).toBe(false);
    expect(f.service.input(f.second, input(epoch, 2), f.field, 103).ok).toBe(false);
  });

  it('restarts input sequence allocation from the acknowledged tick after a flap drops pending commands', () => {
    const f = fixture();
    const epoch = latch(f);

    // This command is accepted into the service but has not reached a game
    // tick, so it must not consume the post-reconnect sequence frontier.
    expect(f.service.input(f.socket, input(epoch, 7, { thrust: true }), f.field, 1).ok).toBe(true);
    expect(f.service.getState(f.actor.id)?.ack).toBe(0);
    expect(f.service.transportClosed(f.socket, 2)).toBe(true);
    const resumed = f.service.resume(f.token, f.second, 100);
    expect(resumed.ok).toBe(true);

    // A resumed predictor starts at ack + 1. The server must accept it after
    // discarding the unacknowledged sequence 7 above.
    expect(f.service.input(f.second, input(epoch, 1), f.field, 101).ok).toBe(true);
    f.service.step(200, f.field);
    expect(f.service.getState(f.actor.id)?.ack).toBe(1);
  });

  it('contains a coupled payload pair as one body while preserving tether length and reflecting outward momentum', () => {
    const f = fixture();
    const primary = f.field[0];
    if (!primary) {
      throw new Error('Missing spinner');
    }
    const payload = rock('payload', 180, 0, 30);
    payload.angularVelocity = 0;
    f.field.push(payload);
    const epoch = latch(f);
    expect(
      f.service.input(
        f.socket,
        input(epoch, 0, { action: 'anchor', targetId: payload.id }),
        f.field,
        0
      ).ok
    ).toBe(true);
    f.service.step(100, f.field);
    expect(f.service.getState(f.actor.id)?.payloadId).toBe(payload.id);

    primary.position = { x: 1110, y: 0 };
    payload.position = { x: 1190, y: 0 };
    primary.velocity = { x: ASTEROID_MOTION.maxLinearVelocity, y: 0 };
    payload.velocity = { x: ASTEROID_MOTION.maxLinearVelocity, y: 0 };
    const separation = Math.hypot(
      primary.position.x - payload.position.x,
      primary.position.y - payload.position.y
    );

    f.service.step(200, f.field);

    const targetRadius = getAsteroidFieldRadius() * ROID.FIELD_INNER_SCALE;
    expect(Math.hypot(primary.position.x, primary.position.y)).toBeLessThanOrEqual(
      targetRadius + 1e-8
    );
    expect(Math.hypot(payload.position.x, payload.position.y)).toBeLessThanOrEqual(
      targetRadius + 1e-8
    );
    expect(
      Math.hypot(primary.position.x - payload.position.x, primary.position.y - payload.position.y)
    ).toBeCloseTo(separation, 6);
    expect(primary.velocity.x + payload.velocity.x).toBeLessThan(0);
  });

  it('caps both unequal-mass tether rocks after a wall bounce and after release', () => {
    const f = fixture();
    const primary = f.field[0];
    if (!primary) {
      throw new Error('Missing spinner');
    }
    const payload = rock('payload', 220, 0, 30);
    f.field.push(payload);
    const epoch = latch(f);
    expect(
      f.service.input(
        f.socket,
        input(epoch, 0, { action: 'anchor', targetId: payload.id }),
        f.field,
        0
      ).ok
    ).toBe(true);
    f.service.step(100, f.field);

    // Unequal masses plus a large relative tangent can leave the lighter rock
    // faster than the common center after wall reflection. Both inputs remain
    // below the cap; the regression targets the post-reflection correction.
    primary.position = { x: 1080, y: 0 };
    payload.position = { x: 1160, y: 0 };
    primary.velocity = { x: 12, y: -9 };
    payload.velocity = { x: 12, y: 9 };
    f.service.step(200, f.field);

    expect(Math.hypot(primary.velocity.x, primary.velocity.y)).toBeLessThanOrEqual(
      ASTEROID_MOTION.maxLinearVelocity + 1e-8
    );
    expect(Math.hypot(payload.velocity.x, payload.velocity.y)).toBeLessThanOrEqual(
      ASTEROID_MOTION.maxLinearVelocity + 1e-8
    );

    expect(f.service.input(f.socket, input(epoch, 1, { action: 'release' }), f.field, 201).ok).toBe(
      true
    );
    f.service.step(300, f.field);
    expect(Math.hypot(primary.velocity.x, primary.velocity.y)).toBeLessThanOrEqual(
      ASTEROID_MOTION.maxLinearVelocity + 1e-8
    );
    expect(Math.hypot(payload.velocity.x, payload.velocity.y)).toBeLessThanOrEqual(
      ASTEROID_MOTION.maxLinearVelocity + 1e-8
    );
  });

  it('caps a single latched rock after an external impulse before it can carry the pilot or escape on release', () => {
    const f = fixture();
    const primary = f.field[0];
    if (!primary) {
      throw new Error('Missing spinner');
    }
    const epoch = latch(f);
    primary.velocity = { x: ASTEROID_MOTION.maxLinearVelocity * 4, y: 0 };

    f.service.step(100, f.field);

    expect(Math.hypot(primary.velocity.x, primary.velocity.y)).toBeLessThanOrEqual(
      ASTEROID_MOTION.maxLinearVelocity + 1e-8
    );
    expect(f.service.input(f.socket, input(epoch, 0, { action: 'release' }), f.field, 101).ok).toBe(
      true
    );
  });

  it('rejects an enhanced free pose that crosses the shared arena kill wall', () => {
    const f = fixture();
    const boundary = getGameBoundary();
    const radius = radiusFromMass(f.actor.mass);
    const inside = boundary.radius - radius - 5;
    f.actor.position = { x: inside, y: 0 };
    const before = { ...f.actor.position };

    expect(
      f.service.acceptFreePose(
        f.socket,
        {
          epoch: 1,
          sequence: 0,
          position: { x: boundary.radius - radius + 1, y: 0 },
          velocity: { x: 1, y: 0 },
          angle: 0,
          thrusting: false,
        },
        0
      ).ok
    ).toBe(false);
    expect(f.actor.position).toEqual(before);
  });

  it('expires tokens and releases physical leases on grace expiry, explicit quit and reset', () => {
    const f = fixture();
    latch(f);
    f.service.transportClosed(f.socket, 0);
    expect(f.service.resume(f.token, f.second, 2000).ok).toBe(false);
    expect(f.service.step(2000, f.field)).toEqual([f.actor.id]);
    expect(f.service.ownsAsteroidMotion('spinner')).toBe(false);
    expect(f.service.resume(f.token, f.second, 2001).ok).toBe(false);
    const g = fixture();
    latch(g);
    expect(g.service.quit(g.socket)).toBe(g.actor.id);
    expect(g.service.resume(g.token, g.second, 1).ok).toBe(false);
    expect(g.actor.harpoonTargetId).toBeUndefined();
    const h = fixture();
    latch(h);
    h.service.reset();
    expect(h.service.resume(h.token, h.second, 1).ok).toBe(false);
    expect(h.service.ownsAsteroidMotion('spinner')).toBe(false);
  });

  it('brakes a spinning source into a real payload orbit and leaves payload velocity intact on release', () => {
    const f = fixture();
    const primary = f.field[0];
    if (!primary) {
      throw new Error('Missing spinner');
    }
    const payload = rock('payload', 200, 0, 30);
    payload.angularVelocity = 0;
    f.field.push(payload);
    const epoch = latch(f);
    const beforeOmega = primary.angularVelocity;
    expect(
      f.service.input(
        f.socket,
        input(epoch, 0, { action: 'brake', targetId: payload.id }),
        f.field,
        0
      ).ok
    ).toBe(true);
    f.service.step(100, f.field);
    expect(f.service.getState(f.actor.id)?.payloadId).toBe(payload.id);
    expect(primary.angularVelocity).toBeLessThan(beforeOmega);
    expect(Math.hypot(payload.velocity.x, payload.velocity.y)).toBeGreaterThan(0);
    expect(
      Math.hypot(primary.position.x - payload.position.x, primary.position.y - payload.position.y)
    ).toBeCloseTo(200, 8);
    const releasedVelocity = { ...payload.velocity };
    expect(f.service.input(f.socket, input(epoch, 1, { action: 'release' }), f.field, 100).ok).toBe(
      true
    );
    f.service.step(120, f.field);
    expect(payload.velocity).toEqual(releasedVelocity);
    expect(f.service.ownsAsteroidMotion(payload.id)).toBe(false);
    expect(f.service.input(f.socket, input(epoch, 2, { action: 'release' }), f.field, 121).ok).toBe(
      false
    );
  });

  it('conserves uncapped angular momentum while dissipating coupling energy', () => {
    const a = rock('a', 0, 0, 40);
    const b = rock('b', 150, 0, 30);
    a.angularVelocity = 0.08;
    b.angularVelocity = -0.02;
    const m1 = asteroidMass(a);
    const m2 = asteroidMass(b);
    const reduced = (m1 * m2) / (m1 + m2);
    const i1 = asteroidInertia(a);
    const i2 = asteroidInertia(b);
    const orbitalI = reduced * 150 ** 2;
    const beforeL = i1 * a.angularVelocity + i2 * b.angularVelocity;
    const beforeE = 0.5 * i1 * a.angularVelocity ** 2 + 0.5 * i2 * b.angularVelocity ** 2;
    coupleAsteroidMomentum(a, b, i1, 6);
    const orbitOmega = (b.velocity.y - a.velocity.y) / 150;
    const afterL = i1 * a.angularVelocity + i2 * b.angularVelocity + orbitalI * orbitOmega;
    const afterE =
      0.5 * i1 * a.angularVelocity ** 2 +
      0.5 * i2 * b.angularVelocity ** 2 +
      0.5 * orbitalI * orbitOmega ** 2;
    expect(afterL).toBeCloseTo(beforeL, 8);
    expect(afterE).toBeLessThan(beforeE);
    expect(m1 * a.velocity.y + m2 * b.velocity.y).toBeCloseTo(0, 8);
  });

  it('prevents coincident, distant and allied-ship payload capture or double ownership', () => {
    const f = fixture();
    const epoch = latch(f);
    f.field.push(rock('coincident', 0, 0, 20), rock('far', 900, 0, 20));
    for (const targetId of ['coincident', 'far', 'other-player']) {
      expect(
        f.service.input(f.socket, input(epoch, 0, { action: 'anchor', targetId }), f.field, 0).ok
      ).toBe(false);
    }
    const other = f.entities.addHumanPlayer(
      'other',
      'Other',
      f.second,
      { x: 100, y: 0 },
      undefined,
      'hauler',
      'ember'
    );
    other.asteroidInteractions = 1;
    other.abilityCooldownFrames = 0;
    expect(f.service.register(other, f.second, 1, 0).ok).toBe(true);
    expect(
      f.service.latch(f.second, { action: 'latch', sequence: 0, targetId: 'spinner' }, f.field, 0)
        .ok
    ).toBe(false);
  });

  it('clears the latch on target loss and invalidates delayed controls across death and respawn', () => {
    const f = fixture();
    const epoch = latch(f);
    f.service.beforeRemove('spinner');
    expect(f.service.getState(f.actor.id)?.mode).toBe('released');
    expect(f.actor.harpoonTimer).toBe(0);
    f.actor.health = 0;
    f.actor.exploding = true;
    f.service.invalidateLife(f.actor.id, 10);
    expect(f.service.input(f.socket, input(epoch, 0), f.field, 11).ok).toBe(false);
    f.actor.health = f.actor.maxHealth;
    f.actor.exploding = false;
    f.actor.position = { x: -100, y: 0 };
    f.service.invalidateLife(f.actor.id, 20);
    expect(f.service.getState(f.actor.id)?.anchor).toEqual({ x: -100, y: 0 });
    expect(f.service.getState(f.actor.id)?.epoch).toBeGreaterThan(epoch);
    expect(
      f.service.acceptFreePose(
        f.socket,
        {
          epoch,
          sequence: 0,
          position: { x: 100, y: 0 },
          velocity: { x: 0, y: 0 },
          angle: 0,
          thrusting: false,
        },
        20
      ).ok
    ).toBe(false);
  });

  it('accepts an actual grown coasting pilot after downhill force and the raw kit cap', () => {
    const f = fixture();
    // The central mountain is steepest halfway from summit to rim.
    const position = { x: getTerrainField().radius / 2, y: 0 };
    const ship = new Ship({ kitId: 'hauler', position: { ...position } });
    f.actor.mass = 8;
    f.actor.position = { ...position };
    const gradient = sampleGradient(getTerrainField(), position.x, position.y);
    const steepness = Math.hypot(gradient.x, gradient.y);
    expect(steepness).toBeGreaterThan(0.0005);

    const downslope = { x: -gradient.x / steepness, y: -gradient.y / steepness };
    // This is a pre-growth velocity from the old raw Hauler cap. Growth then
    // happens before the next coasting update; the client intentionally keeps
    // coasting friction rather than snapping to the new mass cap.
    ship.velocity = { x: downslope.x * ship.maxVelocity, y: downslope.y * ship.maxVelocity };
    ship.mass = f.actor.mass;
    ship.thrusting = false;
    ship.update(1);
    const speed = Math.hypot(ship.velocity.x, ship.velocity.y);
    expect(speed).toBeGreaterThan(5);
    expect(speed).toBeLessThanOrEqual(ship.maxVelocity + 1e-9);

    const state = f.service.getState(f.actor.id);
    if (!state) {
      throw new Error('Motion state missing');
    }
    expect(
      f.service.acceptFreePose(
        f.socket,
        {
          epoch: state.epoch,
          sequence: 0,
          position: { ...ship.position },
          velocity: ship.velocity,
          angle: 0,
          thrusting: false,
        },
        1000 / GAME.FPS
      ).ok
    ).toBe(true);
  });

  it('accepts the actual 8.5 raw cap of a Skirmisher pilot', () => {
    const f = fixture();
    const ship = new Ship({ kitId: 'skirmisher', position: { x: 0, y: 0 } });
    f.actor.kitId = 'skirmisher';
    f.actor.position = { x: 0, y: 0 };
    // Keep thrust engaged so this exercises the client's final raw-kit cap
    // after thrust and terrain force, rather than merely reading the kit.
    ship.velocity = { x: ship.maxVelocity, y: 0 };
    ship.thrusting = true;
    ship.update(1);
    const speed = Math.hypot(ship.velocity.x, ship.velocity.y);
    expect(speed).toBeGreaterThan(8);
    expect(speed).toBeLessThanOrEqual(ship.maxVelocity + 1e-9);

    const state = f.service.getState(f.actor.id);
    if (!state) {
      throw new Error('Motion state missing');
    }
    expect(
      f.service.acceptFreePose(
        f.socket,
        {
          epoch: state.epoch,
          sequence: 0,
          position: { ...ship.position },
          velocity: ship.velocity,
          angle: 0,
          thrusting: false,
        },
        1000 / GAME.FPS
      ).ok
    ).toBe(true);
  });

  it('seeds a bounded ordinary spinning population and caps catch-up work after a stalled tick', () => {
    const f = fixture();
    const ordinary = Array.from({ length: 10 }, (_, index) => {
      const asteroid = rock(`natural-${index}`);
      delete asteroid.spinClass;
      return asteroid;
    });
    const patches = f.service.seedNaturalSpinners(ordinary);
    expect(patches).toHaveLength(3);
    expect(
      patches.every(
        (patch) => Math.abs(patch.angularVelocity) === 0.16 && patch.spinClass === 'natural'
      )
    ).toBe(true);
    const epoch = latch(f);
    const primary = f.field[0];
    if (!primary) {
      throw new Error('Missing spinner');
    }
    const before = primary.rotation;
    f.service.input(f.socket, input(epoch, 0), f.field, 1);
    f.service.step(10000, f.field);
    expect(primary.rotation - before).toBeLessThanOrEqual(
      ASTEROID_MOTION.maxFramesPerStep * ASTEROID_MOTION.maxAngularVelocity
    );
    const held = primary.rotation;
    f.service.step(10000, f.field);
    expect(primary.rotation).toBe(held);
  });
});
