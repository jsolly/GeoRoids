import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { captureSnapshot, encodeSnapshot } from '../../../shared/snapshotProtocol';
import type { PlayerProjectileState, ServerGameSnapshot } from '../../../shared-types';
import { AuthoritativeProjectileField } from '../../../src/entities/laser/AuthoritativeProjectileField';
import { Laser } from '../../../src/entities/laser/Laser';
import { ConnectionManager } from '../../../src/network/services/ConnectionManager';
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
  sent: Array<{ type: string; data?: Record<string, unknown> }> = [];
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
  state.asteroids = [];
  state.loot = [];
  state.satellites = [];
  state.satellitePickups = [];
  state.satelliteProjectiles = [];
  state.collabTags = [];
  state.playerProjectiles = projectiles;
  return state;
}

describe('pilots reconcile complete authoritative bolts through the actual socket receiver', () => {
  let manager: ConnectionManager;
  const field = AuthoritativeProjectileField.getInstance();

  beforeEach(() => {
    vi.stubGlobal('WebSocket', Transport);
    vi.stubEnv('VITE_SNAPSHOT_PROTOCOL', '1');
    manager = ConnectionManager.getInstance();
    manager.disconnect();
  });
  afterEach(() => {
    manager.disconnect();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  function acknowledge(ws: Transport, enhanced: boolean): void {
    ws.receive('joined', {
      id: manager.getClientId(),
      name: 'Projectile observer',
      position: { x: 0, y: 0 },
      snapshotVersion: 1,
      ...(enhanced ? { asteroidInteractions: 1, resumeToken: 'a'.repeat(64) } : {}),
    });
  }

  async function connect(enhanced = true): Promise<Transport> {
    vi.stubEnv('VITE_ASTEROID_INTERACTIONS', enhanced ? '1' : '0');
    const pending = manager.connect();
    const ws = Transport.latest;
    ws.onopen?.();
    await pending;
    manager.setLocalPlayerName('Projectile observer');
    manager.initializeAsteroidSync();
    expect(ws.sent.find((packet) => packet.type === 'join')?.data?.['asteroidInteractions']).toBe(
      enhanced ? 1 : undefined
    );
    acknowledge(ws, enhanced);
    return ws;
  }

  function ship() {
    const player = manager.getPlayer('pilot-1');
    if (!player) {
      throw new Error('Decoded remote pilot is missing');
    }
    return player.ship;
  }

  test('new snapshots update one existing bolt while repeated shoot events and client predictions cannot duplicate it', async () => {
    const ws = await connect();
    const first = frame([bolt('stable-shot')]);
    ws.receive('snapshot', encodeSnapshot(first, 1));
    expect(field.isEnabled()).toBe(true);
    expect(ship().lasers).toHaveLength(1);
    const original = ship().lasers[0];
    expect(original?.serverId).toBe('stable-shot');
    // A pending local visual is provisional, while the server id is durable.
    ship().lasers.push(new Laser({ x: 590, y: 150 }, { x: 5, y: 0 }, 0, 0));
    const moved = frame([bolt('stable-shot', 620)]);
    ws.receive('snapshot', encodeSnapshot(moved, 2, { sequence: 1, state: first }));
    expect(ship().lasers).toHaveLength(1);
    expect(ship().lasers[0]).toBe(original);
    expect(original?.position).toEqual({ x: 620, y: 150 });
    expect(field.getProjectiles()).toEqual(moved.playerProjectiles);
    for (let repeat = 0; repeat < 3; repeat++) {
      ws.receive('playerShoot', {
        id: 'pilot-1',
        shotId: 'stable-shot',
        laserStart: { x: 1, y: 2 },
        laserDirection: { x: -5, y: 0 },
      });
    }
    ws.receive('snapshot', encodeSnapshot(moved, 3, { sequence: 2, state: moved }));
    expect(ship().lasers).toEqual([original]);
    expect(field.getProjectiles()).toHaveLength(1);
    expect(original?.position).toEqual({ x: 620, y: 150 });

    const replacement = frame([bolt('next-shot', 640)]);
    ws.receive('snapshot', encodeSnapshot(replacement, 4, { sequence: 3, state: moved }));
    expect(ship().lasers).toHaveLength(1);
    expect(ship().lasers[0]).not.toBe(original);
    expect(ship().lasers[0]?.serverId).toBe('next-shot');
    const empty = frame([]);
    ws.receive('snapshot', encodeSnapshot(empty, 5, { sequence: 4, state: replacement }));
    expect(ship().lasers).toEqual([]);
    expect(field.getProjectiles()).toEqual([]);
    expect(field.isEnabled()).toBe(true);
  });

  test('a missed delta requests one resync without replaying old bolts and a rejoin recovers exactly the current keyed list', async () => {
    const ws = await connect();
    const first = frame([bolt('old-shot')]);
    ws.receive('snapshot', encodeSnapshot(first, 1));
    const original = ship().lasers[0];
    const advanced = frame([bolt('new-shot')]);
    const missingBaseline = encodeSnapshot(advanced, 3, { sequence: 2, state: first });
    ws.receive('snapshot', missingBaseline);
    ws.receive('snapshot', encodeSnapshot(first, 1));
    expect(ws.sent.filter((packet) => packet.type === 'snapshotResync')).toHaveLength(1);
    expect(ship().lasers).toEqual([original]);
    expect(field.getProjectiles()).toEqual(first.playerProjectiles);
    ws.receive('snapshot', encodeSnapshot(advanced, 20));
    const recovered = ship().lasers[0];
    expect(recovered?.serverId).toBe('new-shot');
    expect(ship().lasers).toHaveLength(1);
    expect(field.getProjectiles()).toEqual(advanced.playerProjectiles);
    ws.receive('playerShoot', {
      id: 'pilot-1',
      shotId: 'old-shot',
      laserStart: { x: 1, y: 2 },
      laserDirection: { x: 5, y: 0 },
    });
    expect(ship().lasers).toEqual([recovered]);
    manager.initializeAsteroidSync();
    acknowledge(ws, true);
    ws.receive('snapshot', encodeSnapshot(advanced, 1));
    expect(ship().lasers).toEqual([recovered]);
    expect(field.getProjectiles()).toHaveLength(1);
    ws.receive('snapshot', encodeSnapshot(frame([]), 2));
    expect(ship().lasers).toEqual([]);
    expect(field.getProjectiles()).toEqual([]);
    expect(ws.close).not.toHaveBeenCalled();
  });

  test('without enhancement negotiation legacy shoot events still create bolts and snapshot rows never replace them', async () => {
    const ws = await connect(false);
    const state = frame([bolt('server-only-shot')]);
    ws.receive('snapshot', encodeSnapshot(state, 1));
    expect(field.isEnabled()).toBe(false);
    expect(field.getProjectiles()).toEqual([]);
    expect(ship().lasers).toEqual([]);
    ws.receive('playerShoot', {
      id: 'pilot-1',
      laserStart: { x: 600, y: 150 },
      laserDirection: { x: 5, y: 0 },
    });
    expect(ship().lasers).toHaveLength(1);
    const legacy = ship().lasers[0];
    expect(legacy?.serverId).toBeUndefined();
    expect(legacy?.position).toEqual({ x: 600, y: 150 });
    ws.receive('snapshot', encodeSnapshot(frame([]), 2, { sequence: 1, state }));
    expect(ship().lasers).toEqual([legacy]);
    expect(field.isEnabled()).toBe(false);
    expect(field.getProjectiles()).toEqual([]);
  });
});
