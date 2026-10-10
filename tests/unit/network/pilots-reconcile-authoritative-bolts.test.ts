import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  captureSnapshot,
  SNAPSHOT_VERSION,
  SnapshotEncoder,
} from '../../../shared/snapshotProtocol';
import type { PlayerProjectileState, ServerGameSnapshot } from '../../../shared-types';
import { LASER } from '../../../src/constants';
import { AuthoritativeProjectileField } from '../../../src/entities/laser/AuthoritativeProjectileField';
import { Laser } from '../../../src/entities/laser/Laser';
import { PlayerManager } from '../../../src/entities/player/PlayerManager';
import { NetworkManager } from '../../../src/network/networkManager';
import { ConnectionManager } from '../../../src/network/services/ConnectionManager';
import { canvasManager } from '../../../src/rendering/canvasSurface';
import { snapshotFixture } from './snapshotFixture';

/** Transport seam only: packets still cross the production onmessage handler,
 * decoder, entity reconciliation and authoritative projectile singleton. */
class Transport {
  static OPEN = 1;
  static CONNECTING = 0;
  static latest: Transport;
  readyState = 1;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  sent: Array<{ type: string; id?: string; data?: Record<string, unknown> }> = [];
  constructor() {
    Transport.latest = this;
  }
  send(text: string): void {
    this.sent.push(JSON.parse(text));
  }
  close = vi.fn(() => {
    this.readyState = 3;
    this.onclose?.();
  });
  receive(type: string, data: unknown): void {
    this.onmessage?.({ data: JSON.stringify({ type, data, timestamp: 1 }) });
  }
}

function bolt(id: string, x = 600): PlayerProjectileState {
  return {
    id,
    ownerId: 'pilot-1',
    position: { x, y: 150 },
    prevPosition: { x: x - 5, y: 150 },
    velocity: { x: 5, y: 0 },
    energy: 1.5,
    bounces: 1,
    age: 5,
  };
}

function frame(projectiles: PlayerProjectileState[]): ServerGameSnapshot {
  const state = captureSnapshot(snapshotFixture());
  state.entities = state.entities.slice(0, 2);
  for (const row of state.entities) {
    row.playerMotion = { epoch: 1, ack: 0, mode: 'free' };
  }
  state.asteroids = [];
  state.loot = [];
  state.satellitePickups = [];
  state.playerProjectiles = projectiles;
  return state;
}

beforeAll(() => {
  const network = NetworkManager.getInstance();
  PlayerManager.getInstance({ networkPort: network, combatNetwork: network.combatNetwork });
});

describe('pilots reconcile complete authoritative bolts through the actual socket receiver', () => {
  let manager: ConnectionManager;
  const field = AuthoritativeProjectileField.getInstance();

  beforeEach(() => {
    vi.stubGlobal('WebSocket', Transport);
    NetworkManager.getInstance();
    manager = ConnectionManager.getInstance();
    manager.disconnect();
  });
  afterEach(() => {
    manager.disconnect();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  function acknowledge(ws: Transport, supportsShots = true): void {
    ws.receive('joined', {
      id: manager.getClientId(),
      name: 'Projectile observer',
      position: { x: 0, y: 0 },
      snapshotVersion: SNAPSHOT_VERSION,
      asteroidInteractions: 1,
      ...(supportsShots ? { shotAcknowledgements: true } : {}),
      resumeToken: 'a'.repeat(64),
    });
  }

  async function connect(): Promise<Transport> {
    const pending = manager.connect();
    const ws = Transport.latest;
    ws.onopen?.();
    await pending;
    manager.setLocalPlayerName('Projectile observer');
    manager.initializeAsteroidSync();
    expect(ws.sent.find((packet) => packet.type === 'join')?.data?.['snapshotVersion']).toBe(
      SNAPSHOT_VERSION
    );
    expect(ws.sent.find((packet) => packet.type === 'join')?.data?.['asteroidInteractions']).toBe(
      1
    );
    acknowledge(ws);
    return ws;
  }

  function receiveLocalPose(ws: Transport): void {
    const state = frame([]);
    const row = state.entities[0];
    const local = PlayerManager.getInstance().getLocalPlayer();
    if (!row || !local) {
      throw new Error('Local pose fixture unavailable');
    }
    row.id = local.id;
    row.position = { ...local.ship.position };
    row.velocity = { ...local.ship.velocity };
    ws.receive('snapshot', new SnapshotEncoder(state).encode(1));
  }

  function ship() {
    const player = manager.getPlayer('pilot-1');
    if (!player) {
      throw new Error('Decoded remote pilot is missing');
    }
    return player.ship;
  }

  test('the real firing client sends its player identity outside the correlated shot data', async () => {
    const local = PlayerManager.getInstance().createLocalPlayer('scout');
    const ws = await connect();
    receiveLocalPose(ws);
    manager.sendPlayerState({ id: manager.getLocalPlayerId(), ...local.getStateForNetwork() });
    const earlierPacket = structuredClone(ws.sent.at(-1));
    const earlierSequence = earlierPacket?.data?.['motionSequence'];
    if (earlierPacket?.type !== 'update' || typeof earlierSequence !== 'number') {
      throw new Error('Earlier ordinary pose was not sent');
    }
    local.ship.position = { x: 15, y: -9 };
    local.ship.velocity = { x: 0.4, y: -0.7 };
    const firingPosition = { ...local.ship.position };
    const firingVelocity = { ...local.ship.velocity };
    expect(earlierPacket.data?.['position']).not.toEqual(firingPosition);
    expect(earlierPacket.data?.['velocity']).not.toEqual(firingVelocity);
    local.ship.fireLaser();
    const packet = ws.sent.findLast((message) => message.type === 'shoot');
    const shotIndex = ws.sent.findLastIndex((message) => message.type === 'shoot');
    const firingPacket = structuredClone(ws.sent[shotIndex - 1]);
    expect(firingPacket).toMatchObject({
      type: 'update',
      data: {
        id: manager.getLocalPlayerId(),
        position: firingPosition,
        velocity: firingVelocity,
        motionEpoch: 1,
      },
    });
    expect(firingPacket?.data?.['motionSequence']).toBeGreaterThan(earlierSequence);
    const laser = local.ship.lasers.at(-1);
    expect(packet?.id).toBe(manager.getClientId());
    expect(packet?.data).not.toHaveProperty('id');
    expect(packet?.data).toMatchObject({
      laserStart: laser?.position,
      laserDirection: laser?.velocity,
      requestId: expect.any(String),
    });
    expect(packet?.data?.['requestId']).not.toBe('');
  });

  test('a pilot awaiting its authoritative pose or losing its update transport cannot send a shot', async () => {
    const local = PlayerManager.getInstance().createLocalPlayer('scout');
    const ws = await connect();
    local.ship.fireLaser();
    expect(ws.sent.some((packet) => packet.type === 'shoot')).toBe(false);
    receiveLocalPose(ws);
    vi.spyOn(ws, 'send').mockImplementation(() => {
      throw new Error('Update transport failed');
    });
    const laser = new Laser({ x: 20, y: 0 }, { x: 1, y: 0 }, 0, 0);
    local.ship.lasers.push(laser);
    manager.sendShootEvent(laser);
    expect(ws.sent.some((packet) => packet.type === 'shoot')).toBe(false);
    expect(ws.close).toHaveBeenCalled();
  });

  test('new snapshots update one existing bolt while provisional client shots cannot duplicate it', async () => {
    const ws = await connect();
    const first = frame([bolt('stable-shot')]);
    ws.receive('snapshot', new SnapshotEncoder(first).encode(1));
    expect(field.isEnabled()).toBe(true);
    expect(ship().lasers).toHaveLength(1);
    const original = ship().lasers[0];
    expect(original?.serverId).toBe('stable-shot');
    // A pending local visual is provisional, while the server id is durable.
    ship().lasers.push(new Laser({ x: 590, y: 150 }, { x: 5, y: 0 }, 0, 0));
    const moved = frame([bolt('stable-shot', 620)]);
    ws.receive('snapshot', new SnapshotEncoder(moved).encode(2, { sequence: 1, state: first }));
    expect(ship().lasers).toHaveLength(1);
    expect(ship().lasers[0]).toBe(original);
    expect(original?.position).toEqual({ x: 620, y: 150 });
    expect(field.getProjectiles()).toEqual(moved.playerProjectiles);
    ws.receive('snapshot', new SnapshotEncoder(moved).encode(3, { sequence: 2, state: moved }));
    expect(ship().lasers).toEqual([original]);
    expect(field.getProjectiles()).toHaveLength(1);
    expect(original?.position).toEqual({ x: 620, y: 150 });

    const replacement = frame([bolt('next-shot', 640)]);
    ws.receive(
      'snapshot',
      new SnapshotEncoder(replacement).encode(4, { sequence: 3, state: moved })
    );
    expect(ship().lasers).toHaveLength(1);
    expect(ship().lasers[0]).not.toBe(original);
    expect(ship().lasers[0]?.serverId).toBe('next-shot');
    const empty = frame([]);
    ws.receive(
      'snapshot',
      new SnapshotEncoder(empty).encode(5, { sequence: 4, state: replacement })
    );
    expect(ship().lasers).toEqual([]);
    expect(field.getProjectiles()).toEqual([]);
    expect(field.isEnabled()).toBe(true);
  });

  test('rejected, timed-out and disconnected predictions leave no ghost and receipts cannot claim another shot', async () => {
    const local = PlayerManager.getInstance().createLocalPlayer('scout');
    const ws = await connect();
    receiveLocalPose(ws);
    const clock = vi.spyOn(performance, 'now').mockReturnValue(100);
    local.ship.fireLaser();
    local.ship.fireLaser();
    local.ship.fireLaser();
    const originals = [...local.ship.lasers];
    expect(originals).toHaveLength(3);
    const requests = ws.sent
      .filter((packet) => packet.type === 'shoot')
      .map((packet) => packet.data?.['requestId']);
    expect(new Set(requests).size).toBe(3);
    ws.receive('shotAcknowledged', {
      requestId: 'unrelated-request',
      projectileId: 'unrelated-bolt',
    });
    ws.receive('shotAcknowledged', { requestId: requests[0], projectileId: 42 });
    expect(local.ship.lasers).toEqual(originals);
    ws.receive('shotAcknowledged', { requestId: requests[1], projectileId: null });
    expect(local.ship.lasers).toEqual([originals[0], originals[2]]);
    ws.receive('shotAcknowledged', { requestId: requests[2], projectileId: 'shot-third' });
    expect(originals[2]?.serverId).toBe('shot-third');
    expect(originals[0]?.serverId).toBeUndefined();
    field.sync([{ ...bolt('shot-third'), ownerId: local.id }]);
    clock.mockReturnValue(100 + LASER.PREDICTION_TIMEOUT_MS);
    field.reconcileShip(local.ship, local.id);
    expect(local.ship.lasers).toEqual([originals[2]]);
    ws.receive('shotAcknowledged', { requestId: requests[0], projectileId: 'late-first' });
    expect(originals[0]?.serverId).toBeUndefined();
    local.ship.fireLaser();
    expect(local.ship.lasers).toHaveLength(2);
    manager.disconnect();
    expect(local.ship.lasers).toEqual([originals[2]]);
  });

  test('a stalled connection expires a stationary prediction without another snapshot or trigger', async () => {
    const local = PlayerManager.getInstance().createLocalPlayer('scout');
    const ws = await connect();
    receiveLocalPose(ws);
    const clock = vi.spyOn(performance, 'now').mockReturnValue(100);
    vi.spyOn(canvasManager, 'getCanvas').mockReturnValue(document.createElement('canvas'));
    vi.spyOn(canvasManager, 'getViewportSize').mockReturnValue({ width: 1280, height: 900 });
    local.ship.angle = 0;
    local.ship.velocity = { x: -LASER.SPEED / 60, y: 0 };
    local.ship.fireLaser();
    const predicted = local.ship.lasers[0];
    expect(predicted?.velocity).toEqual({ x: 0, y: 0 });
    const requestId = ws.sent.findLast((packet) => packet.type === 'shoot')?.data?.['requestId'];
    clock.mockReturnValue(100 + LASER.PREDICTION_TIMEOUT_MS);
    local.ship.update();
    expect(local.ship.lasers).toEqual([]);
    ws.receive('shotAcknowledged', { requestId, projectileId: 'overdue-shot' });
    expect(predicted?.serverId).toBeUndefined();

    local.ship.fireLaser();
    const unobserved = local.ship.lasers[0];
    const overdueRequestId = ws.sent.findLast((packet) => packet.type === 'shoot')?.data?.[
      'requestId'
    ];
    clock.mockReturnValue(100 + LASER.PREDICTION_TIMEOUT_MS * 2);
    // Even if the simulation was backgrounded, the receipt itself must enforce expiry.
    ws.receive('shotAcknowledged', {
      requestId: overdueRequestId,
      projectileId: 'late-background-shot',
    });
    expect(local.ship.lasers).toEqual([]);
    expect(unobserved?.serverId).toBeUndefined();
  });

  test('a client joining a server without shot receipts does not duplicate its authoritative bolt', async () => {
    const local = PlayerManager.getInstance().createLocalPlayer('scout');
    const ws = await connect();
    acknowledge(ws, false);
    receiveLocalPose(ws);
    local.ship.fireLaser();
    expect(ws.sent.findLast((packet) => packet.type === 'shoot')?.data).not.toHaveProperty(
      'requestId'
    );
    field.sync([{ ...bolt('older-server-shot'), ownerId: local.id }]);
    field.reconcileShip(local.ship, local.id);
    expect(local.ship.lasers).toHaveLength(1);
    expect(local.ship.lasers[0]?.serverId).toBe('older-server-shot');
  });

  test('a missed delta requests one resync without replaying old bolts and a rejoin recovers exactly the current keyed list', async () => {
    const ws = await connect();
    const first = frame([bolt('old-shot')]);
    ws.receive('snapshot', new SnapshotEncoder(first).encode(1));
    const original = ship().lasers[0];
    const advanced = frame([bolt('new-shot')]);
    const missingBaseline = new SnapshotEncoder(advanced).encode(3, { sequence: 2, state: first });
    ws.receive('snapshot', missingBaseline);
    ws.receive('snapshot', new SnapshotEncoder(first).encode(1));
    expect(ws.sent.filter((packet) => packet.type === 'snapshotResync')).toHaveLength(1);
    expect(ship().lasers).toEqual([original]);
    expect(field.getProjectiles()).toEqual(first.playerProjectiles);
    ws.receive('snapshot', new SnapshotEncoder(advanced).encode(20));
    const recovered = ship().lasers[0];
    expect(recovered?.serverId).toBe('new-shot');
    expect(ship().lasers).toHaveLength(1);
    expect(field.getProjectiles()).toEqual(advanced.playerProjectiles);
    manager.initializeAsteroidSync();
    acknowledge(ws);
    ws.receive('snapshot', new SnapshotEncoder(advanced).encode(1));
    expect(ship().lasers).toEqual([recovered]);
    expect(field.getProjectiles()).toHaveLength(1);
    ws.receive('snapshot', new SnapshotEncoder(frame([])).encode(2));
    expect(ship().lasers).toEqual([]);
    expect(field.getProjectiles()).toEqual([]);
    expect(ws.close).not.toHaveBeenCalled();
  });
});
