import { SatelliteManager } from '../../../src/entities/satellite/SatelliteManager';
import { SatellitePickupManager } from '../../../src/entities/satellitePickup/SatellitePickupManager';
import { Roid } from '../../../src/entities/roid/Roid';
import type { AsteroidData } from '../../../shared-types';
import { applyAsteroidRowToBelt } from '../../../src/network/services/asteroidFieldSync';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ConnectionManager } from '../../../src/network/services/ConnectionManager';
import { bindAsteroidFieldApply, unbindAsteroidFieldApply } from '../../../src/network/services/asteroidFieldSync';
import { LootField } from '../../../src/entities/loot/LootField';
import { captureSnapshot, encodeSnapshot } from '../../../shared/snapshotProtocol';
import { snapshotFixture } from './snapshotFixture';

class Transport {
  static OPEN = 1;
  static CONNECTING = 0;
  static latest: Transport;
  readyState = 1;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  sent: any[] = [];
  constructor() { Transport.latest = this; }
  send(text: string) { this.sent.push(JSON.parse(text)); }
  close = vi.fn(() => { this.readyState = 3; this.onclose?.(); });
  receive(type: string, data: unknown) { this.onmessage?.({ data: JSON.stringify({ type, data, timestamp: 1 }) }); }
}

describe('actual ConnectionManager WebSocket message path', () => {
  let manager: ConnectionManager;
  beforeEach(() => {
    vi.stubGlobal('WebSocket', Transport);
    manager = ConnectionManager.getInstance();
    manager.disconnect();
  });
  afterEach(() => { manager.disconnect(); unbindAsteroidFieldApply(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
  async function connect(offer: boolean) {
    vi.stubEnv('VITE_SNAPSHOT_PROTOCOL', offer ? '1' : '');
    const connecting = manager.connect(); Transport.latest.onopen?.(); await connecting;
    manager.setLocalPlayerName('Runtime pilot'); manager.initializeAsteroidSync();
    return Transport.latest;
  }
  function acknowledge(ws: Transport, version?: number) {
    ws.receive('joined', { id: manager.getClientId(), name: 'Runtime pilot', position: { x: 0, y: 0 }, color: '#fff', ...(version ? { snapshotVersion: version } : {}) });
  }

  test('offer defaults off and an old server ignoring an offer remains on legacy state', async () => {
    let ws = await connect(false);
    expect(ws.sent.find(m => m.type === 'join').data).not.toHaveProperty('snapshotVersion');
    manager.disconnect(); ws = await connect(true);
    expect(ws.sent.find(m => m.type === 'join').data.snapshotVersion).toBe(1);
    acknowledge(ws);
    const legacy = snapshotFixture();
    ws.receive('gameState', legacy);
    expect(manager.getAllPlayers()).toHaveLength(10);
    expect(LootField.getInstance().getAll()).toEqual(legacy.loot);
    expect(ws.close).not.toHaveBeenCalled();
  });

  test('real decoder applies keyframes/deltas, clears effects/empty worlds and survives malformed frames atomically', async () => {
    const ws = await connect(true); acknowledge(ws, 1);
    const removed: string[] = [];
    bindAsteroidFieldApply({ onCreated: () => {}, onUpdated: () => {}, onDestroyed: () => {}, onReconciled: id => removed.push(id) });
    const first = captureSnapshot(snapshotFixture());
    first.entities[1]!.harpoonTargetId = 'asteroid-1';
    first.entities[1]!.harpoonLatchPos = { x: 1, y: 2 }; first.entities[1]!.harpoonTimer = 90;
    first.entities[1]!.name = 'Runtime pilot'; // Display names are not negotiated identities.
    first.entities[1]!.kitId = 'hauler';
    first.entities[1]!.shieldActive = true; first.entities[1]!.shieldTime = 90;
    ws.receive('snapshot', encodeSnapshot(first, 1));
    expect(manager.getPlayer('pilot-1')?.ship.harpoonTargetId).toBe('asteroid-1');
    const next = captureSnapshot(snapshotFixture(1));
    next.asteroids = []; next.collabTags = []; next.loot = []; next.entities.pop();
    delete next.entities[1]!.kitId; delete next.entities[1]!.factionId;
    next.entities[1]!.name = 'Renamed pilot';
    delete next.entities[1]!.shieldActive; delete next.entities[1]!.shieldTime;
    const delta = encodeSnapshot(next, 2, { sequence: 1, state: first });
    ws.receive('snapshot', { ...delta, sequence: 8 });
    expect(manager.getAllPlayers()).toHaveLength(10);
    expect(LootField.getInstance().getAll()).toHaveLength(15);
    expect(ws.sent.filter(m => m.type === 'snapshotResync')).toHaveLength(1);
    ws.receive('snapshot', delta);
    expect(manager.getAllPlayers()).toHaveLength(9);
    expect(manager.getPlayer('pilot-1')?.ship.harpoonTargetId).toBeUndefined();
    expect(manager.getPlayer('pilot-1')?.ship.harpoonLatchPos).toBeUndefined();
    expect(manager.getPlayer('pilot-1')?.ship.harpoonTimer).toBe(0);
    expect(manager.getPlayer('pilot-1')?.ship.shieldActive).toBe(false);
    expect(manager.getPlayer('pilot-1')?.ship.kitId).toBe('dart');
    expect(manager.getPlayer('pilot-1')?.factionId).toBeUndefined();
    expect(manager.getPlayer('pilot-1')?.name).toBe('Renamed pilot');
    expect(manager.getPlayer('pilot-1')?.ship.shieldTime).toBe(0);
    expect(removed).toHaveLength(80);
    expect(LootField.getInstance().getAll()).toEqual([]);
    ws.receive('snapshot', encodeSnapshot(first, 20));
    expect(manager.getAllPlayers()).toHaveLength(10);
    expect(LootField.getInstance().getAll()).toEqual(first.loot);
  });

  test('EO shots, pickup ownership, tag expiry and asteroid metadata reconcile in real managers', async () => {
    const ws = await connect(true); acknowledge(ws, 1);
    const belt = new Map<string, Roid>();
    function create(row: AsteroidData) {
      const roid = new Roid({ ...row.position }, row.size, row.id);
      Object.assign(roid, { material: row.material, offsets: [...row.offsets], vertices: row.vertices, jaggedness: row.jaggedness });
      belt.set(row.id, roid);
    }
    bindAsteroidFieldApply({ onCreated: create,
      onUpdated: (id, row, complete) => { applyAsteroidRowToBelt(key => belt.get(key), id, row, create, complete); },
      onDestroyed: event => { belt.delete(event.asteroidId); },
      onReconciled: id => { belt.delete(id); },
      onTagged: event => { const roid = belt.get(event.asteroidId); if (roid) { roid.taggedUntil = event.expiresAt; } },
    });
    const first = captureSnapshot(snapshotFixture());
    ws.receive('snapshot', encodeSnapshot(first, 1));
    const satellites = SatelliteManager.getInstance();
    const pickups = SatellitePickupManager.getInstance();
    expect(satellites.getAll()).toHaveLength(6);
    expect(satellites.get('eo-0')?.lasers).toHaveLength(1);
    const projectile = first.satelliteProjectiles[0]!;
    ws.receive('satelliteShoot', { id: projectile.satelliteId, shotId: projectile.shotId, laserStart: projectile.position, laserDirection: projectile.velocity });
    expect(satellites.get('eo-0')?.lasers).toHaveLength(1);
    expect(pickups.get('pickup-0')?.ownerId).toBe('pilot-0');
    expect(belt.get('asteroid-0')?.taggedUntil).toBe(5000);
    const next = captureSnapshot(snapshotFixture(70));
    next.asteroids[0]!.material = 'rubble'; next.asteroids[0]!.vertices = 3;
    next.asteroids[0]!.offsets = [0.7, 1.2, 0.8]; next.asteroids[0]!.jaggedness = 0.9;
    delete next.asteroids[0]!.isCollabTarget;
    next.satellites[0]!.exploding = true; next.satellites[0]!.health = 0;
    next.satelliteProjectiles = [];
    ws.receive('snapshot', encodeSnapshot(next, 2, { sequence: 1, state: first }));
    expect(satellites.get('eo-0')?.lasers).toEqual([]);
    expect(pickups.get('pickup-0')?.ownerId).toBeNull();
    expect(pickups.get('pickup-0')?.shieldFramesRemaining).toBe(0);
    expect(belt.get('asteroid-0')).toMatchObject({ material: 'rubble', offsets: [0.7, 1.2, 0.8], vertices: 3, jaggedness: 0.9, isCollabTarget: false, taggedUntil: 0 });
    // A rejoin starts a new sequence and reconstructs shots even after local caches were lost.
    manager.initializeAsteroidSync(); acknowledge(ws, 1);
    satellites.clear(); pickups.clear();
    ws.receive('snapshot', encodeSnapshot(first, 1));
    expect(satellites.get('eo-0')?.lasers).toHaveLength(1);
    expect(pickups.get('pickup-0')?.ownerId).toBe('pilot-0');
  });

  test('rejoin resets the decoder and unnegotiated snapshots close the transport', async () => {
    const ws = await connect(true); acknowledge(ws, 1);
    const state = captureSnapshot(snapshotFixture());
    ws.receive('snapshot', encodeSnapshot(state, 15));
    manager.initializeAsteroidSync(); acknowledge(ws, 1);
    ws.receive('snapshot', encodeSnapshot(state, 1));
    expect(ws.close).not.toHaveBeenCalled();
    manager.disconnect(); const old = await connect(false); acknowledge(old);
    old.receive('snapshot', encodeSnapshot(state, 1));
    expect(old.close).toHaveBeenCalledWith(1002, 'Snapshot was not negotiated');
  });
});
