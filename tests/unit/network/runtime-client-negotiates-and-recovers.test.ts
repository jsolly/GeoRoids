import { strict as assert } from 'node:assert';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { calculateHealthRegenPerFrame } from '../../../shared/constants/health';
import { captureSnapshot, SnapshotEncoder } from '../../../shared/snapshotProtocol';
import type { AsteroidData } from '../../../shared-types';
import { entityFactory } from '../../../src/entities/EntityFactory';
import { LootField } from '../../../src/entities/loot/LootField';
import type { Player } from '../../../src/entities/player/Player';
import { PlayerManager } from '../../../src/entities/player/PlayerManager';
import { Roid } from '../../../src/entities/roid/Roid';
import { SatelliteManager } from '../../../src/entities/satellite/SatelliteManager';
import { SatellitePickupManager } from '../../../src/entities/satellitePickup/SatellitePickupManager';
import { tickAbilityHost } from '../../../src/entities/ship/shipAbilities';
import { resetControlSources } from '../../../src/input/controlSources';
import { keyDown, keyUp } from '../../../src/input/keybindings';
import { handleMouseDown, handleMouseUp } from '../../../src/input/mouse';
import { applyStickSample } from '../../../src/input/touchControls';
import { readStickSample } from '../../../src/input/touchStick';
import {
  applyAsteroidRowToBelt,
  bindAsteroidFieldApply,
  unbindAsteroidFieldApply,
} from '../../../src/network/services/asteroidFieldSync';
import { ConnectionManager } from '../../../src/network/services/ConnectionManager';
import { setSelectedShipKitId } from '../../../src/ui/shipKitSelect';
import { logger } from '../../../src/utils/Logger';
import { snapshotFixture } from './snapshotFixture';

type TransportMessage = {
  type: string;
  id?: string;
  data?: {
    snapshotVersion?: number;
    asteroidInteractions?: number;
    resumeToken?: string;
    [key: string]: unknown;
  };
};

class Transport {
  static OPEN = 1;
  static CONNECTING = 0;
  static latest: Transport;
  readyState = 1;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  sent: TransportMessage[] = [];
  constructor(public url: string) {
    Transport.latest = this;
  }
  send(text: string) {
    const message: TransportMessage = JSON.parse(text);
    this.sent.push(message);
  }
  close = vi.fn(() => {
    this.readyState = 3;
    this.onclose?.();
  });
  receive(type: string, data: unknown) {
    this.onmessage?.({ data: JSON.stringify({ type, data, timestamp: 1 }) });
  }
}

describe('actual ConnectionManager WebSocket message path', () => {
  let manager: ConnectionManager;
  beforeEach(() => {
    vi.stubGlobal('WebSocket', Transport);
    manager = ConnectionManager.getInstance();
    manager.disconnect();
  });
  afterEach(() => {
    manager.disconnect();
    unbindAsteroidFieldApply();
    vi.restoreAllMocks();
    setSelectedShipKitId('dart');
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    resetControlSources();
  });
  async function connect() {
    const connecting = manager.connect();
    Transport.latest.onopen?.();
    await connecting;
    manager.setLocalPlayerName('Runtime pilot');
    manager.initializeAsteroidSync();
    return Transport.latest;
  }
  function acknowledge(ws: Transport, resumeToken = 'a'.repeat(64)) {
    ws.receive('joined', {
      id: manager.getClientId(),
      name: 'Runtime pilot',
      position: { x: 0, y: 0 },
      color: '#fff',
      snapshotVersion: 1,
      asteroidInteractions: 1,
      resumeToken,
    });
  }

  test.each([
    {
      source: 'keyboard',
      press: (player: Player) => keyDown(new KeyboardEvent('keydown', { code: 'KeyW' }), player),
      release: (player: Player) => keyUp(new KeyboardEvent('keyup', { code: 'KeyW' }), player),
    },
    {
      source: 'right mouse',
      press: (player: Player) =>
        handleMouseDown(new MouseEvent('mousedown', { button: 2 }), player),
      release: (player: Player) => handleMouseUp(new MouseEvent('mouseup', { button: 2 }), player),
    },
    {
      source: 'touch stick',
      press: (player: Player) => applyStickSample(player, readStickSample(80, 0, 0, 0)),
      release: (player: Player) => applyStickSample(player, null),
    },
  ])(
    'late Hauler snapshots preserve held and released $source thrust',
    async ({ press, release }) => {
      const clock = vi.spyOn(Date, 'now').mockReturnValue(10_000);
      const player = entityFactory.createLocalPlayer('Runtime pilot', { x: 500, y: 100 }, 'hauler');
      vi.spyOn(PlayerManager.getInstance(), 'getLocalPlayer').mockReturnValue(player);
      vi.spyOn(PlayerManager.getInstance(), 'getLocalShip').mockReturnValue(player.ship);
      const ws = await connect();
      ws.receive('joined', {
        id: manager.getClientId(),
        name: player.name,
        position: player.ship.position,
        snapshotVersion: 1,
        asteroidInteractions: 1,
        resumeToken: 'a'.repeat(64),
      });
      const state = captureSnapshot(snapshotFixture());
      const [local] = state.entities;
      const [rock] = state.asteroids;
      assert.ok(local && rock);
      Object.assign(local, {
        id: player.id,
        kitId: 'hauler',
        thrusting: false,
        asteroidMotion: { epoch: 3, mode: 'latched', ack: 0, asteroidId: rock.id, latchAngle: 0 },
      });
      state.entities = [local];
      state.playerProjectiles = [];
      state.satelliteProjectiles = [];
      state.collabTags = [];
      state.satellites = [];
      state.satellitePickups = [];
      state.loot = [];
      ws.receive('snapshot', new SnapshotEncoder(state).encode(1));
      press(player);
      expect(player.ship.thrusting).toBe(true);
      // An older echo arrives before the newly held input has been sent.
      clock.mockReturnValue(10_017);
      ws.receive('snapshot', new SnapshotEncoder(state).encode(2));
      manager.sendPlayerState({ id: player.id, name: player.name, ...player.getStateForNetwork() });
      expect(
        ws.sent.filter((message) => message.type === 'asteroidInput').at(-1)?.data
      ).toMatchObject({ thrust: true });

      release(player);
      local.thrusting = true;
      clock.mockReturnValue(10_034);
      ws.receive('snapshot', new SnapshotEncoder(state).encode(3));
      manager.sendPlayerState({ id: player.id, name: player.name, ...player.getStateForNetwork() });
      expect(
        ws.sent.filter((message) => message.type === 'asteroidInput').at(-1)?.data
      ).toMatchObject({ thrust: false });

      press(player);
      const sentBeforeDeath = ws.sent.filter((message) => message.type === 'asteroidInput').length;
      Object.assign(local, { health: 0, exploding: true, thrusting: false });
      clock.mockReturnValue(10_051);
      ws.receive('snapshot', new SnapshotEncoder(state).encode(4));
      manager.sendPlayerState({ id: player.id, name: player.name, ...player.getStateForNetwork() });
      expect(player.ship.thrusting).toBe(false);
      expect(ws.sent.filter((message) => message.type === 'asteroidInput')).toHaveLength(
        sentBeforeDeath
      );
    }
  );

  test('held thrust and turn resume after authoritative respawn', async () => {
    const player = entityFactory.createLocalPlayer('Returning pilot', { x: 0, y: 0 }, 'dart');
    vi.spyOn(PlayerManager.getInstance(), 'getLocalPlayer').mockReturnValue(player);
    const ws = await connect();
    ws.receive('joined', {
      id: manager.getClientId(),
      name: player.name,
      position: player.ship.position,
      snapshotVersion: 1,
      asteroidInteractions: 1,
      resumeToken: 'b'.repeat(64),
    });
    const state = captureSnapshot(snapshotFixture());
    const [local] = state.entities;
    assert.ok(local);
    Object.assign(local, { id: player.id, kitId: 'dart', thrusting: false });
    state.entities = [local];
    const receive = (sequence: number) =>
      ws.receive('snapshot', new SnapshotEncoder(state).encode(sequence));
    receive(1);
    keyDown(new KeyboardEvent('keydown', { code: 'KeyW' }), player);
    keyDown(new KeyboardEvent('keydown', { code: 'KeyA' }), player);
    expect(player.ship.thrusting).toBe(true);
    expect(player.ship.angularVelocity).toBeGreaterThan(0);

    Object.assign(local, { health: 0, exploding: true, respawnTimer: 18 });
    receive(2);
    expect(player.ship.thrusting).toBe(false);
    expect(player.ship.angularVelocity).toBe(0);

    Object.assign(local, {
      health: local.maxHealth,
      exploding: false,
      respawnTimer: 0,
      spawnProtectionTimer: 180,
      position: { x: 400, y: 400 },
    });
    receive(3);
    expect(player.ship.exploding).toBe(false);
    expect(player.ship.thrusting).toBe(true);
    expect(player.ship.angularVelocity).toBeGreaterThan(0);
    keyUp(new KeyboardEvent('keyup', { code: 'KeyW' }), player);
    keyUp(new KeyboardEvent('keyup', { code: 'KeyA' }), player);
    receive(4);
    expect(player.ship.thrusting).toBe(false);
    expect(player.ship.angularVelocity).toBe(0);
  });

  test('sampled snapshots correlate predicted and authoritative local state', async () => {
    const player = entityFactory.createLocalPlayer('Runtime pilot', { x: 900, y: 700 }, 'dart');
    vi.spyOn(PlayerManager.getInstance(), 'getLocalPlayer').mockReturnValue(player);
    const log = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    const ws = await connect();
    ws.receive('joined', {
      id: manager.getClientId(),
      name: 'Runtime pilot',
      position: player.ship.position,
      color: '#fff',
      snapshotVersion: 1,
      asteroidInteractions: 1,
      resumeToken: 'a'.repeat(64),
      serverReleaseId: 'server-release',
    });
    const first = captureSnapshot(snapshotFixture());
    const firstEntity = first.entities[0];
    if (!firstEntity) {
      throw new Error('Expected the snapshot fixture to contain a local entity');
    }
    first.entities = [
      {
        ...firstEntity,
        id: manager.getClientId(),
        position: { x: 500, y: 100 },
        asteroidMotion: { epoch: 3, mode: 'free', ack: 4 },
      },
    ];
    first.asteroids = [];
    first.loot = [];
    first.satellites = [];
    first.satellitePickups = [];
    first.satelliteProjectiles = [];
    first.collabTags = [];
    ws.receive('snapshot', new SnapshotEncoder(first).encode(1));
    ws.receive(
      'snapshot',
      new SnapshotEncoder({ ...first, gameTime: first.gameTime + 1 }).encode(2)
    );
    const checkpoint = captureSnapshot(first);
    checkpoint.gameTime += 450;
    const checkpointEntity = checkpoint.entities[0];
    if (!checkpointEntity) {
      throw new Error('Expected the checkpoint to retain the local entity');
    }
    checkpointEntity.position = { x: 540, y: 120 };
    ws.receive('snapshot', new SnapshotEncoder(checkpoint).encode(450));

    const samples = log.mock.calls.filter(
      ([category, event]) => category === 'STATE' && event === 'snapshot_applied'
    );
    expect(samples).toHaveLength(2);
    expect(samples[0]?.[2]).toMatchObject({
      serverReleaseId: 'server-release',
      snapshotSequence: 1,
      snapshotKind: 'keyframe',
      motionEpoch: 3,
      motionAck: 4,
      clientBeforeApply: { position: { x: 900, y: 700 } },
      authoritativeRow: { position: { x: 500, y: 100 } },
      clientAfterApply: { position: expect.objectContaining({ x: expect.any(Number) }) },
    });
    expect(samples[1]?.[2]).toMatchObject({ snapshotSequence: 450 });
  });

  test('applies authoritative local health damage and partial regeneration snapshots', async () => {
    const player = entityFactory.createLocalPlayer('Runtime pilot', { x: 900, y: 700 }, 'dart');
    vi.spyOn(PlayerManager.getInstance(), 'getLocalPlayer').mockReturnValue(player);
    const ws = await connect();
    acknowledge(ws);

    const baseline = captureSnapshot(snapshotFixture());
    const baselineEntity = baseline.entities[0];
    assert.ok(baselineEntity, 'baseline local entity');
    baselineEntity.id = manager.getClientId();
    baselineEntity.name = player.name;
    baseline.entities = [baselineEntity];
    baseline.asteroids = [];
    baseline.loot = [];
    baseline.satellites = [];
    baseline.satellitePickups = [];
    baseline.satelliteProjectiles = [];
    baseline.collabTags = [];

    ws.receive('snapshot', new SnapshotEncoder(baseline).encode(1));
    expect({
      health: player.ship.health,
      lives: player.lives,
      maxHealth: player.ship.maxHealth,
      exploding: player.ship.exploding,
    }).toEqual({ health: 100, lives: 3, maxHealth: 100, exploding: false });

    const damaged = structuredClone(baseline);
    const damagedEntity = damaged.entities[0];
    assert.ok(damagedEntity, 'damaged local entity');
    damagedEntity.health = 75;
    damaged.gameTime += 1;
    ws.receive(
      'snapshot',
      new SnapshotEncoder(damaged).encode(2, { sequence: 1, state: baseline })
    );
    expect({
      health: player.ship.health,
      lives: player.lives,
      maxHealth: player.ship.maxHealth,
      exploding: player.ship.exploding,
    }).toEqual({ health: 75, lives: 3, maxHealth: 100, exploding: false });

    const healing = structuredClone(damaged);
    const healingEntity = healing.entities[0];
    assert.ok(healingEntity, 'healing local entity');
    const regeneratedHealth = 75 + calculateHealthRegenPerFrame();
    healingEntity.health = regeneratedHealth;
    healing.gameTime += 1;
    ws.receive('snapshot', new SnapshotEncoder(healing).encode(3, { sequence: 2, state: damaged }));
    expect({
      health: player.ship.health,
      lives: player.lives,
      maxHealth: player.ship.maxHealth,
      exploding: player.ship.exploding,
    }).toEqual({
      health: regeneratedHealth,
      lives: 3,
      maxHealth: 100,
      exploding: false,
    });
  });

  test('an expired enhanced session replaces its cached identity before a fresh join', async () => {
    const player = entityFactory.createLocalPlayer('Runtime pilot', { x: 500, y: 100 }, 'dart');
    vi.spyOn(PlayerManager.getInstance(), 'getLocalPlayer').mockReturnValue(player);
    const ws = await connect();
    const oldId = manager.getClientId();
    ws.receive('joined', {
      id: oldId,
      name: 'Runtime pilot',
      position: player.ship.position,
      snapshotVersion: 1,
      asteroidInteractions: 1,
      resumeToken: 'a'.repeat(64),
    });
    const state = captureSnapshot(snapshotFixture());
    const oldEntity = state.entities[0];
    assert.ok(oldEntity, 'expired session entity');
    state.entities = [oldEntity];
    Object.assign(oldEntity, {
      id: oldId,
      name: 'Runtime pilot',
      asteroidMotion: { epoch: 1, mode: 'free', ack: 0 },
    });
    state.asteroids = [];
    state.loot = [];
    state.satellites = [];
    state.satellitePickups = [];
    state.satelliteProjectiles = [];
    state.collabTags = [];
    ws.receive('snapshot', new SnapshotEncoder(state).encode(1));
    expect(manager.getAllPlayers()).toEqual([player]);
    ws.receive('sessionExpired', {});
    const freshJoin = ws.sent.filter((message) => message.type === 'join').at(-1);
    assert.ok(freshJoin, 'fresh join message');
    const freshId = freshJoin.id;
    assert.ok(freshId, 'fresh client id');
    expect(freshId).not.toBe(oldId);
    expect(freshJoin.data).not.toHaveProperty('resumeToken');
    expect(manager.getPlayer(oldId)).toBeUndefined();
    expect(manager.getLocalPlayerId()).toBe(freshId);
    ws.receive('joined', {
      id: freshId,
      name: 'Runtime pilot',
      position: player.ship.position,
      snapshotVersion: 1,
      asteroidInteractions: 1,
      resumeToken: 'b'.repeat(64),
    });
    const freshEntity = state.entities[0];
    assert.ok(freshEntity, 'fresh session entity');
    freshEntity.id = freshId;
    ws.receive('snapshot', new SnapshotEncoder(state).encode(1));
    expect(manager.getAllPlayers()).toEqual([player]);
    expect(manager.getPlayer(freshId)).toBe(player);
    expect(manager.getPlayer(oldId)).toBeUndefined();
    expect(player.id).toBe(freshId);
    expect(manager.getLocalPlayerId()).toBe(freshId);
  });

  test('the client always offers the current snapshot and asteroid interaction protocol', async () => {
    const ws = await connect();
    const initialJoin = ws.sent.find((m) => m.type === 'join');
    assert.ok(initialJoin, 'initial join message');
    const initialJoinData = initialJoin.data;
    assert.ok(initialJoinData, 'initial join data');
    expect(initialJoinData.snapshotVersion).toBe(1);
    expect(initialJoinData.asteroidInteractions).toBe(1);
    expect(new URL(ws.url).searchParams.get('snapshotVersion')).toBe('1');
    expect(new URL(ws.url).searchParams.get('asteroidInteractions')).toBe('1');
    expect(initialJoinData.resumeToken).toBeUndefined();
    acknowledge(ws);
  });

  test('real decoder applies keyframes/deltas, clears effects/empty worlds and survives malformed frames atomically', async () => {
    const errorLog = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const ws = await connect();
    acknowledge(ws);
    const removed: string[] = [];
    bindAsteroidFieldApply({
      onCreated: () => {},
      onUpdated: () => {},
      onDestroyed: () => {},
      onReconciled: (id) => removed.push(id),
    });
    const first = captureSnapshot(snapshotFixture());
    const firstPilot = first.entities[1];
    assert.ok(firstPilot, 'first pilot entity');
    firstPilot.harpoonTargetId = 'asteroid-1';
    firstPilot.harpoonLatchPos = { x: 1, y: 2 };
    firstPilot.harpoonTimer = 90;
    firstPilot.name = 'Runtime pilot'; // Display names are not session identities.
    firstPilot.kitId = 'hauler';
    firstPilot.shieldActive = true;
    firstPilot.shieldTime = 90;
    ws.receive('snapshot', new SnapshotEncoder(first).encode(1));
    expect(manager.getPlayer('pilot-1')?.ship.harpoonTargetId).toBe('asteroid-1');
    const next = captureSnapshot(snapshotFixture(1));
    next.asteroids = [];
    next.collabTags = [];
    next.loot = [];
    next.entities.pop();
    const nextPilot = next.entities[1];
    assert.ok(nextPilot, 'next pilot entity');
    delete nextPilot.kitId;
    delete nextPilot.factionId;
    nextPilot.name = 'Renamed pilot';
    delete nextPilot.shieldActive;
    delete nextPilot.shieldTime;
    const delta = new SnapshotEncoder(next).encode(2, { sequence: 1, state: first });
    ws.receive('snapshot', { ...delta, sequence: 8 });
    expect(manager.getAllPlayers()).toHaveLength(10);
    expect(LootField.getInstance().getAll()).toHaveLength(15);
    expect(ws.sent.filter((m) => m.type === 'snapshotResync')).toHaveLength(1);
    expect(errorLog).toHaveBeenCalledWith(
      'STATE',
      'snapshot_rejected',
      expect.any(Error),
      expect.objectContaining({
        lastAcceptedSequence: 1,
        expectedSequence: 2,
        receivedSequence: 8,
        receivedKind: delta.kind,
      })
    );
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
    ws.receive('snapshot', new SnapshotEncoder(first).encode(20));
    expect(manager.getAllPlayers()).toHaveLength(10);
    expect(LootField.getInstance().getAll()).toEqual(first.loot);
  });

  test('EO shots, pickup ownership, tag expiry and asteroid metadata reconcile in real managers', async () => {
    const ws = await connect();
    acknowledge(ws);
    const belt = new Map<string, Roid>();
    function create(row: AsteroidData) {
      const roid = new Roid({ ...row.position }, row.size, row.id);
      Object.assign(roid, {
        material: row.material,
        offsets: [...row.offsets],
        vertices: row.vertices,
        jaggedness: row.jaggedness,
      });
      belt.set(row.id, roid);
    }
    bindAsteroidFieldApply({
      onCreated: create,
      onUpdated: (id, row, complete) => {
        applyAsteroidRowToBelt((key) => belt.get(key), id, row, create, complete);
      },
      onDestroyed: (event) => {
        belt.delete(event.asteroidId);
      },
      onReconciled: (id) => {
        belt.delete(id);
      },
      onTagged: (event) => {
        const roid = belt.get(event.asteroidId);
        if (roid) {
          roid.taggedUntil = event.expiresAt;
        }
      },
    });
    const first = captureSnapshot(snapshotFixture());
    ws.receive('snapshot', new SnapshotEncoder(first).encode(1));
    const satellites = SatelliteManager.getInstance();
    const pickups = SatellitePickupManager.getInstance();
    expect(satellites.getAll()).toHaveLength(6);
    expect(satellites.get('eo-0')?.lasers).toHaveLength(1);
    const projectile = first.satelliteProjectiles[0];
    assert.ok(projectile, 'satellite projectile');
    ws.receive('satelliteShoot', {
      id: projectile.satelliteId,
      shotId: projectile.shotId,
      laserStart: projectile.position,
      laserDirection: projectile.velocity,
    });
    expect(satellites.get('eo-0')?.lasers).toHaveLength(1);
    expect(pickups.get('pickup-0')?.ownerId).toBe('pilot-0');
    expect(belt.get('asteroid-0')?.taggedUntil).toBe(5000);
    const next = captureSnapshot(snapshotFixture(70));
    const nextAsteroid = next.asteroids[0];
    assert.ok(nextAsteroid, 'next asteroid');
    nextAsteroid.material = 'rubble';
    nextAsteroid.vertices = 3;
    nextAsteroid.offsets = [0.7, 1.2, 0.8];
    nextAsteroid.jaggedness = 0.9;
    delete nextAsteroid.isCollabTarget;
    const nextSatellite = next.satellites[0];
    assert.ok(nextSatellite, 'next satellite');
    nextSatellite.exploding = true;
    nextSatellite.health = 0;
    next.satelliteProjectiles = [];
    ws.receive('snapshot', new SnapshotEncoder(next).encode(2, { sequence: 1, state: first }));
    expect(satellites.get('eo-0')?.lasers).toEqual([]);
    expect(pickups.get('pickup-0')?.ownerId).toBeNull();
    expect(pickups.get('pickup-0')?.shieldFramesRemaining).toBe(0);
    expect(belt.get('asteroid-0')).toMatchObject({
      material: 'rubble',
      offsets: [0.7, 1.2, 0.8],
      vertices: 3,
      jaggedness: 0.9,
      isCollabTarget: false,
      taggedUntil: 0,
    });
    // A rejoin starts a new sequence and reconstructs shots even after local caches were lost.
    manager.initializeAsteroidSync();
    acknowledge(ws);
    satellites.clear();
    pickups.clear();
    ws.receive('snapshot', new SnapshotEncoder(first).encode(1));
    expect(satellites.get('eo-0')?.lasers).toHaveLength(1);
    expect(pickups.get('pickup-0')?.ownerId).toBe('pilot-0');
  });

  test('local Hauler prediction survives queued zeros, while acknowledged expiry clears immediately', async () => {
    setSelectedShipKitId('hauler');
    const player = entityFactory.createLocalPlayer('Runtime pilot', { x: 500, y: 100 }, 'hauler');
    vi.spyOn(PlayerManager.getInstance(), 'getLocalPlayer').mockReturnValue(player);
    const ws = await connect();
    acknowledge(ws);
    const zero = captureSnapshot(snapshotFixture());
    const zeroEntity = zero.entities[0];
    assert.ok(zeroEntity, 'zero snapshot entity');
    zeroEntity.id = manager.getClientId();
    zeroEntity.kitId = 'hauler';
    ws.receive('snapshot', new SnapshotEncoder(zero).encode(1));
    Object.assign(player.ship, {
      harpoonTimer: 30,
      harpoonTargetId: 'asteroid-1',
      harpoonLatchPos: { x: 1, y: 2 },
      abilityActiveFrames: 30,
      abilityCooldownFrames: 80,
    });
    manager.sendMessage({ type: 'useAbility', data: { abilityId: 'harpoon' } });
    ws.receive('snapshot', new SnapshotEncoder(zero).encode(2));
    expect(player.ship.harpoonTimer).toBe(30);
    expect(player.ship.abilityActiveFrames).toBe(30);
    const active = captureSnapshot(zero);
    const activeEntity = active.entities[0];
    assert.ok(activeEntity, 'active snapshot entity');
    Object.assign(activeEntity, {
      harpoonTimer: 28,
      harpoonTargetId: 'asteroid-1',
      harpoonLatchPos: { x: 3, y: 4 },
      abilityActiveFrames: 28,
      abilityCooldownFrames: 78,
    });
    ws.receive('snapshot', new SnapshotEncoder(active).encode(3));
    expect(player.ship.harpoonTimer).toBe(28);
    ws.receive('snapshot', new SnapshotEncoder(zero).encode(4));
    expect(player.ship.harpoonTimer).toBe(0);
    expect(player.ship.harpoonTargetId).toBeUndefined();
    expect(player.ship.harpoonLatchPos).toBeUndefined();
    expect(player.ship.abilityActiveFrames).toBe(0);
    // A second locally predicted use is pending until its server acknowledgment.
    Object.assign(player.ship, {
      harpoonTimer: 20,
      harpoonTargetId: 'asteroid-1',
      harpoonLatchPos: { x: 1, y: 2 },
    });
    manager.sendMessage({ type: 'useAbility', data: { abilityId: 'harpoon' } });
    ws.receive('snapshot', new SnapshotEncoder(zero).encode(5));
    expect(player.ship.harpoonTimer).toBe(20);
    ws.receive('abilityUsed', {
      id: player.id,
      harpoonTimer: 18,
      harpoonTargetId: 'asteroid-1',
      harpoonLatchPos: { x: 3, y: 4 },
    });
    ws.receive('snapshot', new SnapshotEncoder(zero).encode(6));
    expect(player.ship.harpoonTimer).toBe(0);
  });

  test('socket-flap Hauler visuals keep only their remaining timer and end on expiry or target removal', async () => {
    setSelectedShipKitId('hauler');
    const player = entityFactory.createLocalPlayer('Runtime pilot', { x: 500, y: 100 }, 'hauler');
    vi.spyOn(PlayerManager.getInstance(), 'getLocalPlayer').mockReturnValue(player);
    let ws = await connect();
    acknowledge(ws);
    const active = captureSnapshot(snapshotFixture());
    const reconnectedActiveEntity = active.entities[0];
    assert.ok(reconnectedActiveEntity, 'reconnected active entity');
    Object.assign(reconnectedActiveEntity, {
      id: manager.getClientId(),
      kitId: 'hauler',
      harpoonTimer: 3,
      harpoonTargetId: 'asteroid-1',
      harpoonLatchPos: { x: 1, y: 2 },
      abilityActiveFrames: 3,
    });
    ws.receive('snapshot', new SnapshotEncoder(active).encode(1));
    ws.close(); // Actual onclose resets the socket's authority acknowledgment.
    ws = await connect();
    acknowledge(ws);
    const zero = captureSnapshot(active);
    const zeroActiveEntity = zero.entities[0];
    assert.ok(zeroActiveEntity, 'zero active entity');
    zeroActiveEntity.harpoonTimer = 0;
    zeroActiveEntity.abilityActiveFrames = 0;
    delete zeroActiveEntity.harpoonTargetId;
    delete zeroActiveEntity.harpoonLatchPos;
    ws.receive('snapshot', new SnapshotEncoder(zero).encode(1));
    expect(player.ship.harpoonTimer).toBe(3);
    tickAbilityHost(player.ship);
    ws.receive('snapshot', new SnapshotEncoder(zero).encode(2));
    expect(player.ship.harpoonTimer).toBe(2); // No keyframe may restart/extend it.
    tickAbilityHost(player.ship);
    tickAbilityHost(player.ship);
    ws.receive('snapshot', new SnapshotEncoder(zero).encode(3));
    expect(player.ship.harpoonTimer).toBe(0);
    expect(player.ship.harpoonLatchPos).toBeUndefined();
    // A warm prediction also stops immediately if its target vanished.
    Object.assign(player.ship, {
      harpoonTimer: 3,
      harpoonTargetId: 'asteroid-1',
      harpoonLatchPos: { x: 1, y: 2 },
    });
    const removed = captureSnapshot(zero);
    removed.asteroids = removed.asteroids.filter((rock) => rock.id !== 'asteroid-1');
    ws.receive('snapshot', new SnapshotEncoder(removed).encode(4));
    expect(player.ship.harpoonTimer).toBe(0);
    expect(player.ship.harpoonTargetId).toBeUndefined();
    expect(player.ship.harpoonLatchPos).toBeUndefined();
    expect(ws.sent.filter((message) => message.type === 'useAbility')).toHaveLength(0);
  });

  test('rejoin accepts in-flight old-session snapshots until its delayed acknowledgment resets sequence', async () => {
    const ws = await connect();
    acknowledge(ws);
    const state = captureSnapshot(snapshotFixture());
    ws.receive('snapshot', new SnapshotEncoder(state).encode(15));
    manager.initializeAsteroidSync();
    // The previous server session sent this before processing our join. It
    // arrives during the round trip, before the ordered new-session ack.
    const queued = captureSnapshot(snapshotFixture(1));
    const queuedPilot = queued.entities[1];
    assert.ok(queuedPilot, 'queued pilot entity');
    queuedPilot.fuel = 23;
    ws.receive('snapshot', new SnapshotEncoder(queued).encode(16, { sequence: 15, state }));
    expect(ws.close).not.toHaveBeenCalled();
    expect(manager.getPlayer('pilot-1')?.ship.fuel).toBe(23);
    acknowledge(ws);
    ws.receive('snapshot', new SnapshotEncoder(state).encode(1));
    const statePilot = state.entities[1];
    assert.ok(statePilot, 'state pilot entity');
    expect(manager.getPlayer('pilot-1')?.ship.fuel).toBe(statePilot.fuel);
    expect(ws.close).not.toHaveBeenCalled();
  });

  test.each([
    {
      label: 'snapshot version',
      snapshotVersion: 2,
      asteroidInteractions: 1,
      resumeToken: 'a'.repeat(64),
    },
    {
      label: 'asteroid interaction capability',
      snapshotVersion: 1,
      asteroidInteractions: 2,
      resumeToken: 'a'.repeat(64),
    },
    { label: 'resume token', snapshotVersion: 1, asteroidInteractions: 1, resumeToken: 'short' },
  ])('fails closed when the joined acknowledgment omits a valid $label', async (ack) => {
    const ws = await connect();
    ws.receive('joined', {
      id: manager.getClientId(),
      name: 'Runtime pilot',
      position: { x: 0, y: 0 },
      color: '#fff',
      ...ack,
    });
    expect(ws.close).toHaveBeenCalled();
    expect(manager.isConnected()).toBe(false);
  });
});
