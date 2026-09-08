import { entityFactory } from '../../../src/entities/EntityFactory';
import { PlayerManager } from '../../../src/entities/player/PlayerManager';
import { tickAbilityHost } from '../../../src/entities/ship/shipAbilities';
import { setSelectedShipKitId } from '../../../src/ui/shipKitSelect';
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
  constructor(public url: string) { Transport.latest = this; }
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
  afterEach(() => { manager.disconnect(); unbindAsteroidFieldApply(); vi.restoreAllMocks(); setSelectedShipKitId('dart'); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
  async function connect(offer?: boolean) {
    vi.stubEnv('VITE_SNAPSHOT_PROTOCOL', offer === undefined ? undefined : offer ? '1' : '0');
    const connecting = manager.connect(); Transport.latest.onopen?.(); await connecting;
    manager.setLocalPlayerName('Runtime pilot'); manager.initializeAsteroidSync();
    return Transport.latest;
  }
  function acknowledge(ws: Transport, version?: number) {
    ws.receive('joined', { id: manager.getClientId(), name: 'Runtime pilot', position: { x: 0, y: 0 }, color: '#fff', ...(version ? { snapshotVersion: version } : {}) });
  }

  test('an expired enhanced session replaces its cached identity before a fresh join', async () => {
    vi.stubEnv('VITE_ASTEROID_INTERACTIONS', '1');
    const player = entityFactory.createLocalPlayer('Runtime pilot', { x: 500, y: 100 }, 'dart');
    vi.spyOn(PlayerManager.getInstance(), 'getLocalPlayer').mockReturnValue(player);
    const ws = await connect(true);
    const oldId = manager.getClientId();
    ws.receive('joined', { id: oldId, name: 'Runtime pilot', position: player.ship.position,
      snapshotVersion: 1, asteroidInteractions: 1, resumeToken: 'a'.repeat(64) });
    const state = captureSnapshot(snapshotFixture());
    state.entities = [state.entities[0]!];
    Object.assign(state.entities[0]!, { id: oldId, name: 'Runtime pilot',
      asteroidMotion: { epoch: 1, mode: 'free', ack: 0 } });
    state.asteroids = []; state.loot = []; state.satellites = [];
    state.satellitePickups = []; state.satelliteProjectiles = []; state.collabTags = [];
    ws.receive('snapshot', encodeSnapshot(state, 1));
    expect(manager.getAllPlayers()).toEqual([player]);
    ws.receive('sessionExpired', {});
    const freshJoin = ws.sent.filter(message => message.type === 'join').at(-1);
    const freshId = freshJoin.id;
    expect(freshId).not.toBe(oldId);
    expect(freshJoin.data).not.toHaveProperty('resumeToken');
    expect(manager.getPlayer(oldId)).toBeUndefined();
    expect(manager.getLocalPlayerId()).toBe(freshId);
    ws.receive('joined', { id: freshId, name: 'Runtime pilot', position: player.ship.position,
      snapshotVersion: 1, asteroidInteractions: 1, resumeToken: 'b'.repeat(64) });
    state.entities[0]!.id = freshId;
    ws.receive('snapshot', encodeSnapshot(state, 1));
    expect(manager.getAllPlayers()).toEqual([player]);
    expect(manager.getPlayer(freshId)).toBe(player);
    expect(manager.getPlayer(oldId)).toBeUndefined();
    expect(player.id).toBe(freshId);
    expect(manager.getLocalPlayerId()).toBe(freshId);
  });

  test('an unset build setting offers snapshots, explicit 0 disables them, and an old server remains compatible', async () => {
    vi.stubEnv('VITE_ASTEROID_INTERACTIONS', undefined);
    let ws = await connect();
    expect(ws.sent.find(m => m.type === 'join').data.snapshotVersion).toBe(1);
    expect(ws.sent.find(m => m.type === 'join').data.asteroidInteractions).toBe(1);
    expect(new URL(ws.url).searchParams.get('asteroidInteractions')).toBe('1');
    manager.disconnect(); ws = await connect(false);
    expect(ws.sent.find(m => m.type === 'join').data).not.toHaveProperty('snapshotVersion');
    expect(ws.sent.find(m => m.type === 'join').data).not.toHaveProperty('asteroidInteractions');
    vi.stubEnv('VITE_ASTEROID_INTERACTIONS', '0');
    manager.disconnect(); ws = await connect(true);
    expect(ws.sent.find(m => m.type === 'join').data.snapshotVersion).toBe(1);
    expect(ws.sent.find(m => m.type === 'join').data).not.toHaveProperty('asteroidInteractions');
    expect(new URL(ws.url).searchParams.has('asteroidInteractions')).toBe(false);
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

  test('local Hauler prediction survives queued zeros, while acknowledged expiry clears immediately', async () => {
    setSelectedShipKitId('hauler');
    const player = entityFactory.createLocalPlayer('Runtime pilot', { x: 500, y: 100 }, 'hauler');
    vi.spyOn(PlayerManager.getInstance(), 'getLocalPlayer').mockReturnValue(player);
    const ws = await connect(true); acknowledge(ws, 1);
    const zero = captureSnapshot(snapshotFixture());
    zero.entities[0]!.id = manager.getClientId(); zero.entities[0]!.kitId = 'hauler';
    ws.receive('snapshot', encodeSnapshot(zero, 1));
    Object.assign(player.ship, { harpoonTimer: 30, harpoonTargetId: 'asteroid-1',
      harpoonLatchPos: { x: 1, y: 2 }, abilityActiveFrames: 30, abilityCooldownFrames: 80 });
    manager.sendMessage({ type: 'useAbility', data: { abilityId: 'harpoon' } });
    ws.receive('snapshot', encodeSnapshot(zero, 2));
    expect(player.ship.harpoonTimer).toBe(30);
    expect(player.ship.abilityActiveFrames).toBe(30);
    const active = captureSnapshot(zero);
    Object.assign(active.entities[0]!, { harpoonTimer: 28, harpoonTargetId: 'asteroid-1',
      harpoonLatchPos: { x: 3, y: 4 }, abilityActiveFrames: 28, abilityCooldownFrames: 78 });
    ws.receive('snapshot', encodeSnapshot(active, 3));
    expect(player.ship.harpoonTimer).toBe(28);
    ws.receive('snapshot', encodeSnapshot(zero, 4));
    expect(player.ship.harpoonTimer).toBe(0);
    expect(player.ship.harpoonTargetId).toBeUndefined();
    expect(player.ship.harpoonLatchPos).toBeUndefined();
    expect(player.ship.abilityActiveFrames).toBe(0);
    // A second locally predicted use is pending until its server acknowledgment.
    Object.assign(player.ship, { harpoonTimer: 20, harpoonTargetId: 'asteroid-1', harpoonLatchPos: { x: 1, y: 2 } });
    manager.sendMessage({ type: 'useAbility', data: { abilityId: 'harpoon' } });
    ws.receive('snapshot', encodeSnapshot(zero, 5));
    expect(player.ship.harpoonTimer).toBe(20);
    ws.receive('abilityUsed', { id: player.id, harpoonTimer: 18, harpoonTargetId: 'asteroid-1', harpoonLatchPos: { x: 3, y: 4 } });
    ws.receive('snapshot', encodeSnapshot(zero, 6));
    expect(player.ship.harpoonTimer).toBe(0);
  });

  test('socket-flap Hauler visuals keep only their remaining timer and end on expiry or target removal', async () => {
    setSelectedShipKitId('hauler');
    const player = entityFactory.createLocalPlayer('Runtime pilot', { x: 500, y: 100 }, 'hauler');
    vi.spyOn(PlayerManager.getInstance(), 'getLocalPlayer').mockReturnValue(player);
    let ws = await connect(true); acknowledge(ws, 1);
    const active = captureSnapshot(snapshotFixture());
    Object.assign(active.entities[0]!, { id: manager.getClientId(), kitId: 'hauler', harpoonTimer: 3,
      harpoonTargetId: 'asteroid-1', harpoonLatchPos: { x: 1, y: 2 }, abilityActiveFrames: 3 });
    ws.receive('snapshot', encodeSnapshot(active, 1));
    ws.close(); // Actual onclose resets the socket's authority acknowledgment.
    ws = await connect(true); acknowledge(ws, 1);
    const zero = captureSnapshot(active);
    zero.entities[0]!.harpoonTimer = 0; zero.entities[0]!.abilityActiveFrames = 0;
    delete zero.entities[0]!.harpoonTargetId; delete zero.entities[0]!.harpoonLatchPos;
    ws.receive('snapshot', encodeSnapshot(zero, 1));
    expect(player.ship.harpoonTimer).toBe(3);
    tickAbilityHost(player.ship);
    ws.receive('snapshot', encodeSnapshot(zero, 2));
    expect(player.ship.harpoonTimer).toBe(2); // No keyframe may restart/extend it.
    tickAbilityHost(player.ship); tickAbilityHost(player.ship);
    ws.receive('snapshot', encodeSnapshot(zero, 3));
    expect(player.ship.harpoonTimer).toBe(0);
    expect(player.ship.harpoonLatchPos).toBeUndefined();
    // A warm prediction also stops immediately if its target vanished.
    Object.assign(player.ship, { harpoonTimer: 3, harpoonTargetId: 'asteroid-1', harpoonLatchPos: { x: 1, y: 2 } });
    const removed = captureSnapshot(zero);
    removed.asteroids = removed.asteroids.filter(rock => rock.id !== 'asteroid-1');
    ws.receive('snapshot', encodeSnapshot(removed, 4));
    expect(player.ship.harpoonTimer).toBe(0);
    expect(player.ship.harpoonTargetId).toBeUndefined();
    expect(player.ship.harpoonLatchPos).toBeUndefined();
    expect(ws.sent.filter(message => message.type === 'useAbility')).toHaveLength(0);
  });

  test('rejoin accepts in-flight old-session snapshots until its delayed acknowledgment resets sequence', async () => {
    const ws = await connect(true); acknowledge(ws, 1);
    const state = captureSnapshot(snapshotFixture());
    ws.receive('snapshot', encodeSnapshot(state, 15));
    manager.initializeAsteroidSync();
    // The previous server session sent this before processing our join. It
    // arrives during the round trip, before the ordered new-session ack.
    const queued = captureSnapshot(snapshotFixture(1));
    queued.entities[1]!.fuel = 23;
    ws.receive('snapshot', encodeSnapshot(queued, 16, { sequence: 15, state }));
    expect(ws.close).not.toHaveBeenCalled();
    expect(manager.getPlayer('pilot-1')?.ship.fuel).toBe(23);
    acknowledge(ws, 1);
    ws.receive('snapshot', encodeSnapshot(state, 1));
    expect(manager.getPlayer('pilot-1')?.ship.fuel).toBe(state.entities[1]!.fuel);
    expect(ws.close).not.toHaveBeenCalled();
    manager.disconnect(); const old = await connect(false); acknowledge(old);
    old.receive('snapshot', encodeSnapshot(state, 1));
    expect(old.close).toHaveBeenCalledWith(1002, 'Snapshot was not negotiated');
    manager.disconnect();
    const unsupported = await connect(true); acknowledge(unsupported, 2);
    expect(unsupported.close).toHaveBeenCalledWith(1002, 'Unsupported snapshot negotiation');
  });
});
