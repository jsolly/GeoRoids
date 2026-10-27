import { strict as assert } from 'node:assert';
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { observesPreparedFixture } from '../../../benchmarks/fixture-readiness';
import { calculateHealthRegenPerFrame } from '../../../shared/constants/health';
import { SHIP_ABILITY } from '../../../shared/shipKits';
import {
  captureSnapshot,
  SNAPSHOT_VERSION,
  SnapshotEncoder,
} from '../../../shared/snapshotProtocol';
import { TERRAIN } from '../../../shared/terrainConfig';
import type { AsteroidData, ContourBridge, RolyPolyState } from '../../../shared-types';
import { Sound, setSound } from '../../../src/audio/Sound';
import { bindGameAudio, resetGameAudio } from '../../../src/audio/spatialAudio';
import { clientPerformance } from '../../../src/diagnostics/performanceMetrics';
import { LootField } from '../../../src/entities/loot/LootField';
import { createPlayer } from '../../../src/entities/player/createPlayer';
import type { Player } from '../../../src/entities/player/Player';
import { PlayerManager } from '../../../src/entities/player/PlayerManager';
import { Roid } from '../../../src/entities/roid/Roid';
import { SatellitePickupManager } from '../../../src/entities/satellitePickup/SatellitePickupManager';
import { publishHarpoonField } from '../../../src/entities/ship/harpoonField';
import { resetHapticsForTests, setHaptics } from '../../../src/fx/haptics';
import { resetControlSources } from '../../../src/input/controlSources';
import { keyDown, keyUp } from '../../../src/input/keybindings';
import { handleMouseDown } from '../../../src/input/mouse';
import { setTouchHeading } from '../../../src/input/touchControls';
import {
  applyAsteroidKinematics,
  bindAsteroidFieldApply,
  unbindAsteroidFieldApply,
} from '../../../src/network/services/asteroidFieldSync';
import { ConnectionManager } from '../../../src/network/services/ConnectionManager';
import { cooperativeActive, getWorldCampaign } from '../../../src/network/worldCampaign';
import { worldFurnaces } from '../../../src/network/worldExploration';
import { getContourBridges } from '../../../src/physics/terrain/contourBridgeSession';
import { getRolyPolys } from '../../../src/physics/terrain/rolyPolySession';
import { scanCameraZoom } from '../../../src/rendering/canvas';
import { sendCrewAction } from '../../../src/runtime/crewRescue';
import { setSelectedShipKitId } from '../../../src/runtime/shipSelection';
import { logger } from '../../../src/utils/Logger';
import { emptySnapshotFixture, snapshotFixture } from './snapshotFixture';

const LASER_SOUND_PATH_PATTERN = /sounds\/laser\.m4a$/u;
const LOOT_PICKUP_SOUND_PATH_PATTERN = /sounds\/loot-pickup\.m4a$/u;
const SURVEY_SCAN_SOUND_PATH_PATTERN = /survey-scan\.m4a$/u;
const ORBITAL_PICKUP_SOUND_PATH_PATTERN = /orbital-pickup\.m4a$/u;
const HIT_SOUND_PATH_PATTERN = /sounds\/hit\.m4a$/u;
const CLIENT_RELEASE_ID_PATTERN = /^(dev|[a-f0-9]{40})$/u;
const RESUME_TOKEN_PATTERN = /^[a-z0-9]{64}$/u;
const JOIN_ACK_ORDER_ERROR_PATTERN = /before.*join ack/u;

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
    this.receiveRaw(JSON.stringify({ type, data, timestamp: 1 }));
  }
  receiveRaw(text: string) {
    this.onmessage?.({ data: text });
  }
}

beforeAll(() => {
  const network = ConnectionManager.getInstance();
  PlayerManager.getInstance({ networkPort: network, combatNetwork: network.combatNetwork });
});

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
    setSelectedShipKitId('scout');
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
      snapshotVersion: SNAPSHOT_VERSION,
      asteroidInteractions: 1,
      terrainSeed: 7,
      resumeToken,
    });
  }

  test('ability events preserve active effect timers and complete snapshots clear absent timers', async () => {
    const player = createPlayer({
      name: 'Runtime pilot',
      type: 'local',
      position: { x: 900, y: 700 },
      kitId: 'scout',
      combatNetwork: manager.combatNetwork,
    });
    vi.spyOn(PlayerManager.getInstance(), 'getLocalPlayer').mockReturnValue(player);
    const ws = await connect();
    acknowledge(ws);
    const active = captureSnapshot(snapshotFixture());
    const local = active.entities[0];
    assert.ok(local);
    Object.assign(local, {
      id: manager.getClientId(),
      name: player.name,
      kitId: 'scout',
      weaponChargeFrames: 60,
      navigationAssistFrames: 1200,
      contourDraftFrames: 120,
    });
    const remote = { ...structuredClone(local), id: 'effect-crew', name: 'Effect crew' };
    active.entities = [local, remote];
    ws.receive('snapshot', new SnapshotEncoder(active).encode(1));
    const crew = manager.getAllPlayers().find((pilot) => pilot.id === remote.id);
    assert.ok(crew);
    const timers = (pilot: Player) => [
      pilot.ship.weaponChargeFrames,
      pilot.ship.navigationAssistFrames,
      pilot.ship.contourDraftFrames,
    ];
    for (const pilot of [player, crew]) {
      expect(timers(pilot)).toEqual([60, 1200, 120]);
      ws.receive('abilityUsed', {
        id: pilot.id,
        kitId: 'scout',
        abilityActiveFrames: 0,
        harpoonTargetId: null,
      });
      expect(timers(pilot)).toEqual([60, 1200, 120]);
    }
    const cleared = structuredClone(active);
    for (const row of cleared.entities) {
      row.weaponChargeFrames = 0;
      row.navigationAssistFrames = 0;
      row.contourDraftFrames = 0;
    }
    ws.receive('snapshot', new SnapshotEncoder(cleared).encode(2, { sequence: 1, state: active }));
    expect(timers(player)).toEqual([0, 0, 0]);
    expect(timers(crew)).toEqual([0, 0, 0]);
    ws.receive('snapshot', new SnapshotEncoder(active).encode(3));
    const absent = structuredClone(active);
    for (const row of absent.entities) {
      delete row.weaponChargeFrames;
      delete row.navigationAssistFrames;
      delete row.contourDraftFrames;
    }
    ws.receive('snapshot', new SnapshotEncoder(absent).encode(4, { sequence: 3, state: active }));
    expect(timers(player)).toEqual([0, 0, 0]);
    expect(timers(crew)).toEqual([0, 0, 0]);
  });

  test.each(['disconnect', 'sessionExpired'] as const)(
    'encoded wildlife and bridge snapshots update, remove and clear across %s',
    async (lifetime) => {
      let ws = await connect();
      acknowledge(ws);
      const animal: RolyPolyState = {
        id: 'animal-one',
        position: { x: 50, y: 50 },
        velocity: { x: 0.15, y: 0 },
        phase: 'walking',
      };
      const bridge: ContourBridge = {
        id: 'bridge-one',
        ownerId: 'crew-one',
        from: { x: 10, y: 20 },
        to: { x: 40, y: 50 },
        source: { height: 0, direction: 1 },
        target: { height: TERRAIN.CONTOUR_INTERVAL, direction: 1 },
        charged: true,
        framesLeft: 180,
      };
      const initial = captureSnapshot(snapshotFixture());
      initial.rolyPolys = [animal];
      initial.contourBridges = [bridge];
      ws.receive('snapshot', new SnapshotEncoder(initial).encode(1));
      expect(getRolyPolys()).toEqual([animal]);
      expect(getContourBridges()).toEqual([bridge]);
      const updated = structuredClone(initial);
      updated.rolyPolys = [{ ...animal, phase: 'curled', position: { x: 75, y: 50 } }];
      updated.contourBridges = [{ ...bridge, charged: false, framesLeft: 90 }];
      ws.receive(
        'snapshot',
        new SnapshotEncoder(updated).encode(2, { sequence: 1, state: initial })
      );
      expect(getRolyPolys()).toEqual(updated.rolyPolys);
      expect(getContourBridges()).toEqual(updated.contourBridges);
      const removed = structuredClone(updated);
      delete removed.rolyPolys;
      delete removed.contourBridges;
      ws.receive(
        'snapshot',
        new SnapshotEncoder(removed).encode(3, { sequence: 2, state: updated })
      );
      expect(getRolyPolys()).toEqual([]);
      expect(getContourBridges()).toEqual([]);
      ws.receive('snapshot', new SnapshotEncoder(initial).encode(4));
      expect(getRolyPolys()).toHaveLength(1);
      expect(getContourBridges()).toHaveLength(1);
      if (lifetime === 'disconnect') {
        manager.disconnect();
      } else {
        ws.receive('sessionExpired', { reason: 'expired' });
      }
      expect(getRolyPolys()).toEqual([]);
      expect(getContourBridges()).toEqual([]);
      if (lifetime === 'disconnect') {
        ws = await connect();
      }
      acknowledge(ws);
      const fresh = captureSnapshot(snapshotFixture());
      fresh.rolyPolys = [{ ...animal, id: 'animal-new' }];
      fresh.contourBridges = [{ ...bridge, id: 'bridge-new' }];
      ws.receive('snapshot', new SnapshotEncoder(fresh).encode(1));
      expect(getRolyPolys()).toEqual(fresh.rolyPolys);
      expect(getContourBridges()).toEqual(fresh.contourBridges);
    }
  );

  test.each(['disconnect', 'sessionExpired'] as const)(
    'encoded campaign and crew state reconciles supplies, clears and a fresh session after %s',
    async (lifetime) => {
      const player = createPlayer({
        name: 'Runtime pilot',
        position: { x: 0, y: 0 },
        type: 'local',
        kitId: 'hauler',
      });
      vi.spyOn(PlayerManager.getInstance(), 'getLocalPlayer').mockReturnValue(player);
      vi.spyOn(PlayerManager.getInstance(), 'getLocalShip').mockReturnValue(player.ship);
      const belt = new Map<string, Roid>();
      const create = (row: AsteroidData) => {
        const rock = new Roid(row);
        belt.set(row.id, rock);
      };
      bindAsteroidFieldApply({
        readBelt: () => [...belt.values()],
        onCreated: create,
        onUpdated: (id, row) => {
          const rock = belt.get(id);
          if (rock) {
            applyAsteroidKinematics(rock, row);
          }
        },
        onDestroyed: (event) => belt.delete(event.asteroidId),
        onReconciled: (id) => belt.delete(id),
      });
      let ws = await connect();
      acknowledge(ws);
      const initial = captureSnapshot(snapshotFixture());
      const local = initial.entities[0];
      const rock = initial.asteroids[0];
      assert.ok(local && rock);
      Object.assign(local, {
        id: manager.getClientId(),
        name: player.name,
        kitId: 'hauler',
        health: 0,
        downedUntil: 30_000,
        rescue: { targetId: 'rescue-crew', completesAt: 3_000 },
        crewSignal: { kind: 'help', position: { x: 100, y: 0 }, expiresAt: 30_000 },
      });
      const remote = { ...structuredClone(local), id: 'rescue-crew', name: 'Rescue crew' };
      initial.entities = [local, remote];
      rock.supply = { sourceId: 'town-square', value: 1_000 };
      initial.asteroids = [rock];
      initial.cooperativeActive = true;
      initial.campaign = {
        projectValue: 4_000,
        supplies: [{ id: 'town-square', value: 2_000 }],
        hives: [],
        cleared: ['frontier:2,0'],
        commissioned: ['frontier:2,0'],
        hazard: { phase: 'warning', kind: 'swarm', startsAt: 100_000, endsAt: 180_000 },
        meteors: [{ id: 'meteor-old', position: { x: 40, y: 50 } }],
      };
      ws.receive('snapshot', new SnapshotEncoder(initial).encode(1));
      const crew = manager.getAllPlayers().find((pilot) => pilot.id === remote.id);
      assert.ok(crew);
      expect(cooperativeActive()).toBe(true);
      expect(getWorldCampaign()).toEqual(initial.campaign);
      expect(worldFurnaces.isLit('frontier:2,0')).toBe(true);
      for (const pilot of [player, crew]) {
        expect(pilot.ship).toMatchObject({
          health: 0,
          downedUntil: 30_000,
          rescue: local.rescue,
          crewSignal: local.crewSignal,
          exploding: false,
        });
      }
      const physicalShipment = belt.get(rock.id);
      assert.ok(physicalShipment);
      expect(physicalShipment.supply).toEqual({ sourceId: 'town-square', value: 1_000 });
      const updated = structuredClone(initial);
      assert.ok(updated.campaign && updated.asteroids[0]);
      updated.campaign.projectValue = 5_000;
      updated.campaign.commissioned = [];
      updated.campaign.meteors = [];
      delete updated.asteroids[0].supply;
      for (const row of updated.entities) {
        row.health = 49;
        row.downedUntil = null;
        row.rescue = null;
        row.crewSignal = null;
      }
      ws.receive(
        'snapshot',
        new SnapshotEncoder(updated).encode(2, { sequence: 1, state: initial })
      );
      expect(getWorldCampaign()).toEqual(updated.campaign);
      expect(worldFurnaces.isLit('frontier:2,0')).toBe(false);
      expect(belt.get(rock.id)).toBe(physicalShipment);
      expect(physicalShipment.supply).toBeUndefined();
      for (const pilot of [player, crew]) {
        expect(pilot.ship).toMatchObject({
          health: 49,
          downedUntil: null,
          rescue: null,
          crewSignal: null,
        });
      }
      const cleared = structuredClone(updated);
      delete cleared.cooperativeActive;
      delete cleared.campaign;
      cleared.asteroids = [];
      ws.receive(
        'snapshot',
        new SnapshotEncoder(cleared).encode(3, { sequence: 2, state: updated })
      );
      expect(cooperativeActive()).toBe(false);
      expect(getWorldCampaign()).toBeUndefined();
      expect(belt.size).toBe(0);
      ws.receive('snapshot', new SnapshotEncoder(initial).encode(4));
      expect(worldFurnaces.isLit('frontier:2,0')).toBe(true);
      if (lifetime === 'disconnect') {
        manager.disconnect();
      } else {
        ws.receive('sessionExpired', { reason: 'expired' });
      }
      expect(cooperativeActive()).toBe(false);
      expect(getWorldCampaign()).toBeUndefined();
      expect(worldFurnaces.isLit('frontier:2,0')).toBe(false);
      if (lifetime === 'disconnect') {
        ws = await connect();
      }
      acknowledge(ws);
      const fresh = structuredClone(updated);
      const freshLocal = fresh.entities[0];
      assert.ok(freshLocal && fresh.campaign);
      freshLocal.id = manager.getClientId();
      fresh.campaign.projectValue = 700;
      fresh.campaign.cleared = [];
      fresh.entities = [freshLocal];
      fresh.asteroids = [{ ...rock }];
      delete fresh.asteroids[0]?.supply;
      ws.receive('snapshot', new SnapshotEncoder(fresh).encode(1));
      expect(getWorldCampaign()?.projectValue).toBe(700);
      expect(player.ship).toMatchObject({
        health: 49,
        downedUntil: null,
        rescue: null,
        crewSignal: null,
      });
      expect(manager.getAllPlayers().find((pilot) => pilot.id === remote.id)).toBeUndefined();
      expect(belt.get(rock.id)?.supply).toBeUndefined();
    }
  );

  test('owned revive and release commands predict a stop and reconcile authoritative rescue state', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(100_000);
    const player = createPlayer({
      name: 'Runtime pilot',
      position: { x: 0, y: 0 },
      type: 'local',
      kitId: 'hauler',
    });
    vi.spyOn(PlayerManager.getInstance(), 'getLocalPlayer').mockReturnValue(player);
    vi.spyOn(PlayerManager.getInstance(), 'getLocalShip').mockReturnValue(player.ship);
    const ws = await connect();
    acknowledge(ws);
    const initial = captureSnapshot(snapshotFixture());
    initial.serverTime = 4_000;
    const local = initial.entities[0];
    assert.ok(local);
    Object.assign(local, { id: manager.getClientId(), kitId: 'hauler', rescue: null });
    initial.entities = [local];
    initial.cooperativeActive = true;
    ws.receive('snapshot', new SnapshotEncoder(initial).encode(1));
    player.ship.velocity = { x: 4, y: -2 };
    player.ship.thrusting = true;
    player.ship.contourLock = { height: 0, direction: 1 };
    sendCrewAction({ kind: 'revive', targetId: 'downed-friend' });
    expect(player.ship.rescue).toEqual({ targetId: 'downed-friend', completesAt: 7_000 });
    expect(player.ship.velocity).toEqual({ x: 0, y: 0 });
    expect(player.ship.thrusting).toBe(false);
    expect(player.ship.contourLock).toBeNull();
    expect(ws.sent.filter((row) => row.type === 'crewAction')).toEqual([
      { type: 'crewAction', id: player.id, data: { kind: 'revive', targetId: 'downed-friend' } },
    ]);
    const accepted = structuredClone(initial);
    const acceptedLocal = accepted.entities[0];
    assert.ok(acceptedLocal);
    acceptedLocal.rescue = { targetId: 'downed-friend', completesAt: 7_200 };
    ws.receive(
      'snapshot',
      new SnapshotEncoder(accepted).encode(2, { sequence: 1, state: initial })
    );
    expect(player.ship.rescue).toEqual(acceptedLocal.rescue);
    sendCrewAction({ kind: 'release' });
    expect(player.ship.rescue).toBeNull();
    expect(ws.sent.filter((row) => row.type === 'crewAction').at(-1)).toEqual({
      type: 'crewAction',
      id: player.id,
      data: { kind: 'release' },
    });
    const released = structuredClone(accepted);
    const releasedLocal = released.entities[0];
    assert.ok(releasedLocal);
    releasedLocal.rescue = null;
    ws.receive(
      'snapshot',
      new SnapshotEncoder(released).encode(3, { sequence: 2, state: accepted })
    );
    expect(player.ship.rescue).toBeNull();
  });

  test('charge commands wait for server support and forget it on reconnect', async () => {
    const player = createPlayer({
      name: 'Runtime pilot',
      type: 'local',
      position: { x: 0, y: 0 },
      kitId: 'scout',
      combatNetwork: manager.combatNetwork,
    });
    vi.spyOn(PlayerManager.getInstance(), 'getLocalPlayer').mockReturnValue(player);
    vi.spyOn(PlayerManager.getInstance(), 'getLocalShip').mockReturnValue(player.ship);
    let ws = await connect();
    acknowledge(ws);
    expect(ws.sent.find((row) => row.type === 'join')?.data?.['worldRemains']).toBe(1);
    expect(manager.combatNetwork.sendCharge('start')).toBe(false);
    expect(ws.sent.some((row) => row.type === 'chargeWeapon')).toBe(false);
    ws.receive('joined', {
      id: manager.getClientId(),
      name: 'Runtime pilot',
      position: { x: 0, y: 0 },
      color: '#fff',
      snapshotVersion: SNAPSHOT_VERSION,
      asteroidInteractions: 1,
      terrainSeed: 7,
      resumeToken: 'a'.repeat(64),
      chargedWeapons: 1,
    });
    player.ship.beginWeaponCharge();
    expect(player.ship.weaponChargeStartedAt).not.toBeNull();
    expect(ws.sent.filter((row) => row.type === 'chargeWeapon')).toHaveLength(1);
    ws.close();
    expect(player.ship.weaponChargeStartedAt).toBeNull();
    expect(player.ship.weaponChargeFrames).toBe(0);
    ws = await connect();
    expect(manager.combatNetwork.sendCharge('release')).toBe(false);
    acknowledge(ws);
    expect(manager.combatNetwork.sendCharge('start')).toBe(false);
    expect(ws.sent.some((row) => row.type === 'chargeWeapon')).toBe(false);
  });

  test.each([1, 7])('a returning pilot moves after its saved epoch %i restarts', async (epoch) => {
    const player = createPlayer({
      name: 'Runtime pilot',
      type: 'local',
      position: { x: 0, y: 0 },
      kitId: 'scout',
      ...(manager.combatNetwork !== undefined ? { combatNetwork: manager.combatNetwork } : {}),
    });
    vi.spyOn(PlayerManager.getInstance(), 'getLocalPlayer').mockReturnValue(player);
    vi.spyOn(PlayerManager.getInstance(), 'getLocalShip').mockReturnValue(player.ship);
    let ws = await connect();
    acknowledge(ws);
    const frame = captureSnapshot(snapshotFixture());
    const displayedShip = player.ship;
    const pilot = frame.entities[0];
    assert.ok(pilot);
    pilot.id = manager.getClientId();
    pilot.playerMotion = { epoch, mode: 'free', ack: 80 };
    const remoteId = 'reconciled-crew';
    frame.entities.push({ ...pilot, id: remoteId, name: 'Reconciled crew' });
    ws.receive('snapshot', new SnapshotEncoder(frame).encode(1));

    // A hidden tab can outlive the live actor. Its private credential restores
    // the saved pilot with the same ID but a new motion session starting at 1.
    ws.close();
    ws = await connect();
    acknowledge(ws);
    pilot.playerMotion = { epoch: 1, mode: 'free', ack: 0 };
    pilot.position = { x: 2382, y: 2849 };
    ws.receive('snapshot', new SnapshotEncoder(frame).encode(1));
    expect(manager.getAllPlayers().find((candidate) => candidate.id === player.id)).toBe(player);
    expect(player.ship).toBe(displayedShip);
    const remote = manager.getAllPlayers().find((candidate) => candidate.id === remoteId);
    assert.ok(remote);
    const sendShoot = vi.spyOn(manager, 'sendShootEvent').mockImplementation(() => undefined);
    remote.ship.fireLaser();
    expect(sendShoot).toHaveBeenCalledExactlyOnceWith(remote.ship.lasers[0]);
    sendShoot.mockRestore();
    expect(player.ship.serverOwnsMotion).toBe(false);
    expect(player.ship.position).toEqual(pilot.position);
    manager.sendPlayerState({ id: player.id, ...player.getStateForNetwork() });
    expect(ws.sent.at(-1)).toMatchObject({
      type: 'update',
      data: { motionEpoch: 1, motionSequence: 1 },
    });
    const before = { ...player.ship.position };
    player.ship.update();
    expect(player.ship.position).not.toEqual(before);
  });

  test('nearby remote shots sound once, self echoes stay silent and collected loot is deduplicated', async () => {
    const player = createPlayer({
      name: 'Listening pilot',
      type: 'local',
      position: { x: 0, y: 0 },
      kitId: 'scout',
    });
    vi.spyOn(PlayerManager.getInstance(), 'getLocalPlayer').mockReturnValue(player);
    const ws = await connect();
    acknowledge(ws);
    ws.receive('snapshot', new SnapshotEncoder(captureSnapshot(emptySnapshotFixture())).encode(1));
    setSound(true);
    bindGameAudio({
      getListenerPosition: () => ({ x: 0, y: 0 }),
      getViewport: () => ({ width: 800, height: 600 }),
    });
    const played: string[] = [];
    vi.spyOn(Sound.prototype, 'play').mockImplementation(function (this: Sound) {
      played.push(this.src);
      return Promise.resolve();
    });
    vi.spyOn(Sound.prototype, 'playNote').mockImplementation(function (this: Sound) {
      played.push(this.src);
      return true;
    });
    try {
      ws.receive('playerShotFired', {
        id: 'remote-shot',
        ownerId: 'other-pilot',
        position: { x: 30, y: 0 },
      });
      expect(played).toHaveLength(1);
      expect(played[0]).toMatch(LASER_SOUND_PATH_PATTERN);
      ws.receive('playerShotFired', {
        id: 'self-shot',
        ownerId: player.id,
        position: { x: 0, y: 0 },
      });
      ws.receive('playerShotFired', {
        id: 'distant-shot',
        ownerId: 'other-pilot',
        position: { x: 10000, y: 0 },
      });
      ws.receive('playerShotFired', { ownerId: 'other-pilot', position: { x: 'bad', y: 0 } });
      expect(played).toHaveLength(1);
      const collection = {
        lootId: 'collected-shard',
        collectorId: 'other-pilot',
        kind: 'shard',
        position: { x: 30, y: 0 },
      };
      ws.receive('lootCollected', collection);
      ws.receive('lootCollected', collection);
      expect(played).toHaveLength(2);
      expect(played[1]).toMatch(LOOT_PICKUP_SOUND_PATH_PATTERN);
      ws.receive('lootCollected', { ...collection, lootId: 'tap-canister', kind: 'tap' });
      expect(played).toHaveLength(3);
      expect(played[2]).toMatch(LOOT_PICKUP_SOUND_PATH_PATTERN);
      ws.receive('lootCollected', { ...collection, lootId: 'mined-points', kind: 'points' });
      expect(played).toHaveLength(4);
      expect(played[3]).toMatch(LOOT_PICKUP_SOUND_PATH_PATTERN);
      ws.receive('lootCollected', { ...collection, lootId: 'invalid-kind', kind: 'unknown' });
      ws.receive('lootCollected', {
        ...collection,
        lootId: 'distant-loot',
        position: { x: 10000, y: 0 },
      });
      expect(played).toHaveLength(4);
      setSound(false);
      ws.receive('playerShotFired', {
        id: 'muted-shot',
        ownerId: 'other-pilot',
        position: { x: 30, y: 0 },
      });
      ws.receive('lootCollected', { ...collection, lootId: 'muted-loot' });
      expect(played).toHaveLength(4);
      manager.disconnect();
      const reconnected = await connect();
      acknowledge(reconnected);
      setSound(true);
      reconnected.receive('lootCollected', collection);
      expect(played).toHaveLength(4);
      reconnected.receive(
        'snapshot',
        new SnapshotEncoder(captureSnapshot(emptySnapshotFixture())).encode(1)
      );
      reconnected.receive('lootCollected', collection);
      expect(played).toHaveLength(4);
      reconnected.receive('lootCollected', { ...collection, lootId: 'new-live-pickup' });
      expect(played).toHaveLength(5);
    } finally {
      resetGameAudio();
      setSound(false);
    }
  });

  test('each partial collection sounds once while replayed and malformed receipts stay silent', async () => {
    const ws = await connect();
    acknowledge(ws);
    ws.receive('snapshot', new SnapshotEncoder(captureSnapshot(emptySnapshotFixture())).encode(1));
    setSound(true);
    bindGameAudio({
      getListenerPosition: () => ({ x: 0, y: 0 }),
      getViewport: () => ({ width: 800, height: 600 }),
    });
    const played = vi.spyOn(Sound.prototype, 'playNote').mockReturnValue(true);
    const vibrate = vi.fn();
    vi.stubGlobal('navigator', { vibrate });
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    resetHapticsForTests();
    setHaptics(true);
    vibrate.mockClear();
    let now = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const collection = {
      eventId: 'first-collection',
      lootId: 'partly-collected-points',
      collectorId: manager.getLocalPlayerId(),
      kind: 'points',
      position: { x: 0, y: 0 },
    };
    try {
      ws.receive('lootCollected', collection);
      ws.receive('lootCollected', collection);
      now += 1000;
      ws.receive('lootCollected', { ...collection, eventId: 'second-collection' });
      ws.receive('lootCollected', { ...collection, eventId: '' });
      ws.receive('lootCollected', { ...collection, eventId: 42 });
      expect(played).toHaveBeenCalledTimes(2);
      expect(vibrate).toHaveBeenCalledTimes(2);
      now += 1000;
      ws.receive('lootCollected', {
        ...collection,
        eventId: 'remote-collection',
        collectorId: 'other-pilot',
      });
      expect(played).toHaveBeenCalledTimes(3);
      expect(vibrate).toHaveBeenCalledTimes(2);
    } finally {
      setHaptics(false);
      resetHapticsForTests();
      resetGameAudio();
      setSound(false);
    }
  });

  test('cargo completion sounds once after accepted deposits, never for spending or reconnect baselines', async () => {
    let ws = await connect();
    acknowledge(ws);
    const frame = captureSnapshot(snapshotFixture());
    const actor = frame.entities[0];
    assert.ok(actor);
    actor.id = manager.getClientId();
    actor.cargo = 50;
    actor.bankedCargo = 200;
    setSound(true);
    const deliveries = vi.fn();
    vi.spyOn(Sound.prototype, 'play').mockImplementation(function (this: Sound) {
      if (this.src.endsWith('/sounds/delivery.m4a')) {
        deliveries();
      }
      return Promise.resolve();
    });
    const send = (sequence: number) =>
      ws.receive('snapshot', new SnapshotEncoder(frame).encode(sequence));
    try {
      send(1);
      actor.cargo = 25;
      actor.bankedCargo = 225;
      send(2);
      expect(deliveries).not.toHaveBeenCalled();
      actor.cargo = 0;
      actor.bankedCargo = 250;
      send(3);
      send(4);
      actor.score = 0;
      send(5);
      expect(deliveries).toHaveBeenCalledOnce();
      actor.cargo = 10;
      send(6);
      expect(actor.health).toBeGreaterThan(0);
      expect(actor.exploding).toBe(false);
      actor.cargo = 0;
      send(7);
      expect(deliveries).toHaveBeenCalledOnce();
      actor.cargo = 10;
      send(8);
      manager.disconnect();
      ws = await connect();
      acknowledge(ws);
      actor.bankedCargo = 260;
      actor.cargo = 0;
      send(1);
      expect(deliveries).toHaveBeenCalledOnce();
      actor.cargo = 10;
      send(2);
      actor.cargo = 0;
      actor.health = 0;
      actor.exploding = true;
      send(3);
      expect(deliveries).toHaveBeenCalledOnce();
    } finally {
      setSound(false);
    }
  });

  test('tap ejection events sound once; malformed, distant and baseline loot stay silent', async () => {
    const ws = await connect();
    acknowledge(ws);
    setSound(true);
    bindGameAudio({
      getListenerPosition: () => ({ x: 0, y: 0 }),
      getViewport: () => ({ width: 800, height: 600 }),
    });
    const notes = vi.spyOn(Sound.prototype, 'playNote').mockReturnValue(true);
    try {
      const event = { lootId: 'tap-1', position: { x: 10, y: 0 } };
      ws.receive('tapEjected', { ...event, lootId: 'before-baseline' });
      ws.receive('lootCollected', {
        lootId: 'old-pickup',
        kind: 'tap',
        collectorId: 'other',
        position: { x: 10, y: 0 },
      });
      expect(notes).not.toHaveBeenCalled();
      const state = captureSnapshot(emptySnapshotFixture());
      state.loot = [
        { id: 'existing-tap', kind: 'tap', position: { x: 10, y: 0 }, mass: 0.1, radius: 5 },
      ];
      ws.receive('snapshot', new SnapshotEncoder(state).encode(1));
      expect(notes).not.toHaveBeenCalled();
      ws.receive('tapEjected', event);
      ws.receive('tapEjected', event);
      ws.receive('tapEjected', { ...event, lootId: 'bad', position: { x: 'bad', y: 0 } });
      ws.receive('tapEjected', { ...event, lootId: 'far', position: { x: 5000, y: 0 } });
      expect(notes).toHaveBeenCalledTimes(1);
      setSound(false);
      ws.receive('tapEjected', { ...event, lootId: 'muted' });
      setSound(true);
      ws.receive('tapEjected', { ...event, lootId: 'muted' });
      expect(notes).toHaveBeenCalledTimes(1);
    } finally {
      resetGameAudio();
      setSound(false);
    }
  });

  test('a surviving local hull hit has feedback; a zero-damage notification stays quiet', async () => {
    const player = createPlayer({
      name: 'Hull pilot',
      type: 'local',
      position: { x: 0, y: 0 },
      kitId: 'scout',
    });
    vi.spyOn(PlayerManager.getInstance(), 'getLocalPlayer').mockReturnValue(player);
    const ws = await connect();
    acknowledge(ws);
    ws.receive('snapshot', new SnapshotEncoder(captureSnapshot(emptySnapshotFixture())).encode(1));
    setSound(true);
    const played: string[] = [];
    vi.spyOn(Sound.prototype, 'play').mockImplementation(function (this: Sound) {
      played.push(this.src);
    });
    const damage = {
      targetPlayerId: player.id,
      attackerId: 'asteroid',
      damage: 10,
      remainingHealth: 90,
      isDestroyed: false,
    };
    ws.receive('playerDamaged', damage);
    expect(played).toContain('/sounds/hull-damage.m4a');
    played.length = 0;
    ws.receive('playerDamaged', damage);
    expect(played).toEqual([]);
    player.ship.contourLock = { height: 0, direction: 1 };
    played.length = 0;
    ws.receive('playerDamaged', { ...damage, damage: 0 });
    expect(player.ship.contourLock).toEqual({ height: 0, direction: 1 });
    expect(played).toEqual([]);
    setSound(false);
  });

  test.each([false, true])(
    'a coupling accepted without a visible latch confirms release; ignition: %s',
    async (ignited) => {
      const player = createPlayer({
        name: 'Hauler pilot',
        type: 'local',
        position: { x: 0, y: 0 },
        kitId: 'hauler',
      });
      vi.spyOn(PlayerManager.getInstance(), 'getLocalPlayer').mockReturnValue(player);
      const ws = await connect();
      acknowledge(ws);
      ws.receive(
        'snapshot',
        new SnapshotEncoder(captureSnapshot(emptySnapshotFixture())).encode(1)
      );
      setSound(true);
      bindGameAudio({
        getListenerPosition: () => player.ship.position,
        getViewport: () => ({ width: 390, height: 844 }),
      });
      const played: string[] = [];
      vi.spyOn(Sound.prototype, 'play').mockImplementation(function (this: Sound) {
        played.push(this.src);
      });
      try {
        ws.receive('abilityUsed', {
          id: player.id,
          kitId: 'hauler',
          abilityId: 'harpoon',
          harpoonTargetId: null,
          abilityActiveFrames: 0,
          ...(ignited
            ? {
                boostIgnitionPosition: {
                  x: player.ship.position.x + 250,
                  y: player.ship.position.y,
                },
              }
            : {}),
        });
        expect(played).toEqual(['/sounds/harpoon-release.m4a']);
      } finally {
        resetGameAudio();
        setSound(false);
      }
    }
  );

  test('tow ability events and following snapshots share one sound per transition', async () => {
    setSelectedShipKitId('hauler');
    const player = createPlayer({
      name: 'Tow audio pilot',
      type: 'local',
      position: { x: 0, y: 0 },
      kitId: 'hauler',
    });
    vi.spyOn(PlayerManager.getInstance(), 'getLocalPlayer').mockReturnValue(player);
    const ws = await connect();
    acknowledge(ws);
    const frame = captureSnapshot(snapshotFixture());
    const pilot = frame.entities[0];
    assert.ok(pilot);
    pilot.id = manager.getClientId();
    pilot.kitId = 'hauler';
    pilot.playerMotion = { epoch: 1, mode: 'free', ack: 0 };
    ws.receive('snapshot', new SnapshotEncoder(frame).encode(1));
    setSound(true);
    bindGameAudio({
      getListenerPosition: () => player.ship.position,
      getViewport: () => ({ width: 390, height: 844 }),
    });
    const played: string[] = [];
    vi.spyOn(Sound.prototype, 'play').mockImplementation(function (this: Sound) {
      played.push(this.src);
    });
    try {
      const outbound = {
        id: player.id,
        kitId: 'hauler' as const,
        abilityId: 'harpoon',
        abilityActiveFrames: 0,
        harpoonTargetId: null,
        utilityFlight: {
          kind: 'tow' as const,
          phase: 'outbound' as const,
          position: { ...player.ship.position },
          velocity: { x: 10, y: 0 },
          remainingDistance: 100,
        },
      };
      ws.receive('abilityUsed', outbound);
      ws.receive('abilityUsed', outbound);
      player.updateFromServer(outbound);
      const latched = {
        ...outbound,
        utilityFlight: null,
        harpoonTargetId: 'tow-rock',
        harpoonLatchPos: { ...player.ship.position },
      };
      ws.receive('abilityUsed', latched);
      player.updateFromServer(latched);
      ws.receive('abilityUsed', { ...latched, harpoonTargetId: null });
      player.updateFromServer({ harpoonTargetId: null });
      expect(played).toEqual([
        '/sounds/harpoon-launch.m4a',
        '/sounds/harpoon-latch.m4a',
        '/sounds/harpoon-release.m4a',
      ]);
    } finally {
      resetGameAudio();
      setSound(false);
    }
  });

  test('a warm reconnect silently hydrates destruction before later deaths sound normally', async () => {
    const liveBelt = new Map<string, AsteroidData>();
    bindAsteroidFieldApply({
      readBelt: () => [...liveBelt.values()],
      onCreated: (row) => {
        liveBelt.set(row.id, row);
      },
      onUpdated: () => {},
      onDestroyed: (event) => {
        liveBelt.delete(event.asteroidId);
      },
      onReconciled: (id) => {
        liveBelt.delete(id);
      },
    });
    const player = createPlayer({
      name: 'Returning pilot',
      type: 'local',
      position: { x: 0, y: 0 },
      kitId: 'scout',
      ...(manager.combatNetwork !== undefined ? { combatNetwork: manager.combatNetwork } : {}),
    });
    vi.spyOn(PlayerManager.getInstance(), 'getLocalPlayer').mockReturnValue(player);
    const ws = await connect();
    acknowledge(ws);
    const alive = captureSnapshot(snapshotFixture());
    for (const pickup of alive.satellitePickups ?? []) {
      pickup.position = { x: 0, y: 0 };
    }
    ws.receive('snapshot', new SnapshotEncoder(alive).encode(1));
    const retained = SatellitePickupManager.getInstance().getAll()[0];
    assert.ok(retained);
    ws.close();
    const resumed = await connect();
    acknowledge(resumed);
    const dead = captureSnapshot(alive);
    for (const pickup of dead.satellitePickups ?? []) {
      pickup.state = 'broken';
      pickup.health = 0;
    }
    setSound(true);
    bindGameAudio({
      getListenerPosition: () => ({ x: 0, y: 0 }),
      getViewport: () => ({ width: 800, height: 600 }),
    });
    const played = vi.spyOn(Sound.prototype, 'play').mockResolvedValue(undefined);
    try {
      resumed.receive('snapshot', new SnapshotEncoder(dead).encode(1));
      expect(SatellitePickupManager.getInstance().get(retained.id)).toBe(retained);
      expect(retained.state).toBe('broken');
      expect(played).not.toHaveBeenCalled();
      resumed.receive('snapshot', new SnapshotEncoder(alive).encode(2));
      played.mockClear();
      resumed.receive('snapshot', new SnapshotEncoder(dead).encode(3));
      expect(played).toHaveBeenCalledTimes(dead.satellitePickups?.length ?? 0);
    } finally {
      resetGameAudio();
      setSound(false);
    }
  });

  test('mineral scan waits for one accepted ability cue and unknown orbital pickups use event positions', async () => {
    const player = createPlayer({
      name: 'Survey pilot',
      type: 'local',
      position: { x: 0, y: 0 },
      kitId: 'scout',
      ...(manager.combatNetwork !== undefined ? { combatNetwork: manager.combatNetwork } : {}),
    });
    vi.spyOn(PlayerManager.getInstance(), 'getLocalPlayer').mockReturnValue(player);
    const ws = await connect();
    acknowledge(ws);
    ws.receive('snapshot', new SnapshotEncoder(captureSnapshot(emptySnapshotFixture())).encode(1));
    setSound(true);
    bindGameAudio({
      getListenerPosition: () => ({ x: 0, y: 0 }),
      getViewport: () => ({ width: 800, height: 600 }),
    });
    const paths: string[] = [];
    vi.spyOn(Sound.prototype, 'play').mockImplementation(function (this: Sound) {
      paths.push(this.src);
      return Promise.resolve();
    });
    try {
      expect(player.ship.activateAbility()).toBe(true);
      expect(ws.sent.filter((message) => message.type === 'useAbility')).toEqual([
        expect.objectContaining({
          id: player.id,
          data: {},
        }),
      ]);
      expect(paths).toEqual([]);
      ws.receive('abilityUsed', { id: player.id, kitId: 'scout', abilityId: 'surveyScan' });
      expect(paths).toHaveLength(1);
      expect(paths[0]).toMatch(SURVEY_SCAN_SOUND_PATH_PATTERN);
      const pickup = {
        pickupId: 'uncached',
        playerId: 'uncached-pilot',
        playerName: 'Remote',
        pickupName: 'Echo',
        scoreBonus: 1,
      };
      ws.receive('satellitePickupCollected', { ...pickup, position: { x: 10000, y: 0 } });
      ws.receive('satellitePickupCollected', pickup);
      expect(paths).toHaveLength(1);
      ws.receive('satellitePickupCollected', { ...pickup, position: { x: 30, y: 0 } });
      expect(paths).toHaveLength(2);
      expect(paths[1]).toMatch(ORBITAL_PICKUP_SOUND_PATH_PATTERN);
    } finally {
      resetGameAudio();
      setSound(false);
    }
  });

  test('a chipped deposit plays one directional hit cue and malformed events stay silent', async () => {
    const player = createPlayer({
      name: 'Mining pilot',
      type: 'local',
      position: { x: 0, y: 0 },
      kitId: 'scout',
      ...(manager.combatNetwork !== undefined ? { combatNetwork: manager.combatNetwork } : {}),
    });
    vi.spyOn(PlayerManager.getInstance(), 'getLocalPlayer').mockReturnValue(player);
    const ws = await connect();
    acknowledge(ws);
    ws.receive('snapshot', new SnapshotEncoder(captureSnapshot(emptySnapshotFixture())).encode(1));
    setSound(true);
    bindGameAudio({
      getListenerPosition: () => ({ x: 0, y: 0 }),
      getViewport: () => ({ width: 800, height: 600 }),
    });
    const paths: string[] = [];
    vi.spyOn(Sound.prototype, 'play').mockImplementation(function (this: Sound) {
      paths.push(this.src);
      return Promise.resolve();
    });
    try {
      // An event without a rock, or without a usable position, never sounds.
      // The position-less shape is the one the guard exists for: without it the
      // cue would play centred at full volume instead of being culled.
      ws.receive('asteroidHit', { asteroidId: '', position: { x: 30, y: 0 } });
      ws.receive('asteroidHit', { asteroidId: 'ore' });
      ws.receive('asteroidHit', { asteroidId: 'ore', position: { x: Number.NaN, y: 0 } });
      expect(paths).toEqual([]);

      // The cue is directional, so a chip beyond the viewport stays silent.
      ws.receive('asteroidHit', { asteroidId: 'ore', position: { x: 10000, y: 0 } });
      expect(paths).toEqual([]);

      ws.receive('asteroidHit', { asteroidId: 'ore', position: { x: 30, y: 0 } });
      expect(paths).toHaveLength(1);
      expect(paths[0]).toMatch(HIT_SOUND_PATH_PATTERN);
    } finally {
      resetGameAudio();
      setSound(false);
    }
  });

  test('intentional disconnect clears movement recovery after retiring the socket', async () => {
    const player = createPlayer({
      name: 'Departing pilot',
      type: 'local',
      position: { x: 0, y: 0 },
      kitId: 'hauler',
    });
    vi.spyOn(PlayerManager.getInstance(), 'getLocalPlayer').mockReturnValue(player);
    vi.spyOn(PlayerManager.getInstance(), 'getLocalShip').mockReturnValue(player.ship);
    const ws = await connect();
    acknowledge(ws);
    player.ship.serverOwnsMotion = true;
    player.ship.playerMotion = { epoch: 1, mode: 'handoff', ack: 0, anchor: { x: 0, y: 0 } };
    manager.disconnect();
    expect(ws.close).toHaveBeenCalled();
    expect(player.ship.serverOwnsMotion).toBe(false);
    expect(player.ship.playerMotion).toBeUndefined();
    expect(manager.isConnected).toBe(false);
  });

  test('a new socket and join cannot reuse a departed session snapshot witness', async () => {
    const player = createPlayer({
      name: 'Runtime pilot',
      type: 'local',
      position: { x: 0, y: 0 },
      kitId: 'scout',
    });
    vi.spyOn(PlayerManager.getInstance(), 'getLocalPlayer').mockReturnValue(player);
    vi.spyOn(PlayerManager.getInstance(), 'getLocalShip').mockReturnValue(player.ship);
    const oldSocket = await connect();
    const oldId = manager.getClientId();
    acknowledge(oldSocket);
    const oldSession = captureSnapshot(snapshotFixture());
    const oldPilot = oldSession.entities[0];
    assert.ok(oldPilot, 'old-session pilot');
    oldPilot.id = oldId;
    oldPilot.playerMotion = { epoch: 9, ack: 0, mode: 'free' };
    oldSession.entities = [oldPilot];
    oldSession.gameTime = 4000;
    oldSocket.receive('snapshot', new SnapshotEncoder(oldSession).encode(1));
    expect(player.ship.playerMotion?.epoch).toBe(9);
    const oldMessage = oldSocket.onmessage;
    assert.ok(oldMessage, 'old socket message handler');

    manager.disconnect({ newSession: true });
    expect(clientPerformance.read().lastSnapshot).toBeUndefined();
    expect(clientPerformance.read().lastKeyframeSequence).toBe(0);
    const freshSocket = await connect();
    const freshId = manager.getClientId();
    expect(freshId).not.toBe(oldId);
    acknowledge(freshSocket, 'b'.repeat(64));
    const freshSession = captureSnapshot(oldSession);
    const freshPilot = freshSession.entities[0];
    assert.ok(freshPilot, 'fresh-session pilot');
    freshPilot.id = freshId;
    freshPilot.playerMotion = { epoch: 2, ack: 0, mode: 'free' };
    freshSocket.receive('snapshot', new SnapshotEncoder(freshSession).encode(1));
    expect(player.ship.playerMotion?.epoch).toBe(2);
    expect(clientPerformance.read()).toMatchObject({
      lastKeyframeSequence: 1,
      lastSnapshot: { gameTime: 4000 },
    });

    expect(
      observesPreparedFixture(
        { sequence: 1, gameTime: 4000, motionEpoch: 2 },
        {
          lastKeyframeSequence: 2,
          lastSnapshotGameTime: oldSession.gameTime,
          motionEpoch: oldPilot.playerMotion.epoch,
        }
      )
    ).toBe(true);
    oldMessage({
      data: JSON.stringify({
        type: 'snapshot',
        data: new SnapshotEncoder(oldSession).encode(2, {
          sequence: 1,
          state: oldSession,
        }),
        timestamp: 1,
      }),
    });
    expect(player.id).toBe(freshId);
    expect(player.ship.playerMotion?.epoch).toBe(2);
    expect(clientPerformance.read().lastKeyframeSequence).toBe(1);
  });

  test.each([
    {
      source: 'keyboard',
      expectedThrust: true,
      press: (player: Player) => keyDown(new KeyboardEvent('keydown', { code: 'KeyW' }), player),
      release: (player: Player) => keyUp(new KeyboardEvent('keyup', { code: 'KeyW' }), player),
    },
    {
      source: 'right mouse',
      expectedThrust: false,
      press: (player: Player) =>
        handleMouseDown(new MouseEvent('mousedown', { button: 2 }), player),
    },
    {
      source: 'touch steering',
      expectedThrust: false,
      press: (player: Player) => setTouchHeading(player, 0),
      release: (player: Player) => setTouchHeading(player, null),
    },
  ])(
    'late Hauler snapshots preserve intentional thrust through $source input until authoritative death',
    async ({ press, release, expectedThrust }) => {
      const clock = vi.spyOn(Date, 'now').mockReturnValue(10_000);
      const player = createPlayer({
        name: 'Runtime pilot',
        type: 'local',
        position: { x: 500, y: 100 },
        kitId: 'hauler',
      });
      vi.spyOn(PlayerManager.getInstance(), 'getLocalPlayer').mockReturnValue(player);
      vi.spyOn(PlayerManager.getInstance(), 'getLocalShip').mockReturnValue(player.ship);
      const ws = await connect();
      ws.receive('joined', {
        id: manager.getClientId(),
        name: player.name,
        position: player.ship.position,
        snapshotVersion: SNAPSHOT_VERSION,
        asteroidInteractions: 1,
        terrainSeed: 7,
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
        playerMotion: { epoch: 3, mode: 'free', ack: 0 },
      });
      state.entities = [local];
      state.playerProjectiles = [];
      state.satellitePickups = [];
      state.loot = [];
      ws.receive('snapshot', new SnapshotEncoder(state).encode(1));
      press(player);
      expect(player.ship.thrusting).toBe(expectedThrust);
      // An older echo arrives before the newly held input has been sent.
      clock.mockReturnValue(10_017);
      ws.receive('snapshot', new SnapshotEncoder(state).encode(2));
      manager.sendPlayerState({ id: player.id, ...player.getStateForNetwork() });
      expect(ws.sent.filter((message) => message.type === 'update').at(-1)?.data).toMatchObject({
        thrusting: expectedThrust,
      });

      release?.(player);
      local.thrusting = true;
      clock.mockReturnValue(10_034);
      ws.receive('snapshot', new SnapshotEncoder(state).encode(3));
      manager.sendPlayerState({ id: player.id, ...player.getStateForNetwork() });
      expect(ws.sent.filter((message) => message.type === 'update').at(-1)?.data).toMatchObject({
        thrusting: false,
      });

      press(player);
      Object.assign(local, { health: 0, exploding: true, thrusting: false });
      clock.mockReturnValue(10_051);
      ws.receive('snapshot', new SnapshotEncoder(state).encode(4));
      manager.sendPlayerState({ id: player.id, ...player.getStateForNetwork() });
      expect(player.ship.thrusting).toBe(false);
      expect(ws.sent.filter((message) => message.type === 'asteroidInput')).toHaveLength(0);
    }
  );

  test('cruise and held turn resume after authoritative respawn', async () => {
    const player = createPlayer({
      name: 'Returning pilot',
      type: 'local',
      position: { x: 0, y: 0 },
      kitId: 'scout',
      ...(manager.combatNetwork !== undefined ? { combatNetwork: manager.combatNetwork } : {}),
    });
    const displayedShip = player.ship;
    vi.spyOn(PlayerManager.getInstance(), 'getLocalPlayer').mockReturnValue(player);
    const ws = await connect();
    ws.receive('joined', {
      id: manager.getClientId(),
      name: player.name,
      position: player.ship.position,
      snapshotVersion: SNAPSHOT_VERSION,
      asteroidInteractions: 1,
      terrainSeed: 7,
      resumeToken: 'b'.repeat(64),
    });
    const state = captureSnapshot(snapshotFixture());
    const [local] = state.entities;
    assert.ok(local);
    Object.assign(local, { id: player.id, kitId: 'scout', thrusting: false });
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
    expect(manager.getAllPlayers().find((candidate) => candidate.id === player.id)).toBe(player);
    expect(player.ship).toBe(displayedShip);
    expect(player.ship.exploding).toBe(false);
    expect(player.ship.thrusting).toBe(true);
    expect(player.ship.angularVelocity).toBeGreaterThan(0);
    keyUp(new KeyboardEvent('keyup', { code: 'KeyW' }), player);
    keyUp(new KeyboardEvent('keyup', { code: 'KeyA' }), player);
    receive(4);
    expect(player.ship.thrusting).toBe(false);
    expect(player.ship.angularVelocity).toBe(0);
  });

  test('applies authoritative local health damage and partial regeneration snapshots', async () => {
    const player = createPlayer({
      name: 'Runtime pilot',
      type: 'local',
      position: { x: 900, y: 700 },
      kitId: 'scout',
    });
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
    baseline.satellitePickups = [];
    ws.receive('snapshot', new SnapshotEncoder(baseline).encode(1));
    expect({
      health: player.ship.health,
      cargo: player.cargo,
      purchases: player.purchases,
      maxHealth: player.ship.maxHealth,
      exploding: player.ship.exploding,
    }).toEqual({ health: 100, cargo: 0, purchases: [], maxHealth: 100, exploding: false });

    const damaged = structuredClone(baseline);
    const damagedEntity = damaged.entities[0];
    assert.ok(damagedEntity, 'damaged local entity');
    damagedEntity.health = 75;
    damaged.gameTime += 1;
    ws.receive(
      'snapshot',
      new SnapshotEncoder(damaged).encode(2, { sequence: 1, state: baseline })
    );
    player.ship.updateLifecycle(600);
    expect(player.ship.health).toBe(75);
    expect({
      health: player.ship.health,
      cargo: player.cargo,
      purchases: player.purchases,
      maxHealth: player.ship.maxHealth,
      exploding: player.ship.exploding,
    }).toEqual({ health: 75, cargo: 0, purchases: [], maxHealth: 100, exploding: false });

    const healing = structuredClone(damaged);
    const healingEntity = healing.entities[0];
    assert.ok(healingEntity, 'healing local entity');
    const regeneratedHealth = 75 + calculateHealthRegenPerFrame(player.ship.maxHealth);
    healingEntity.health = regeneratedHealth;
    healing.gameTime += 1;
    ws.receive('snapshot', new SnapshotEncoder(healing).encode(3, { sequence: 2, state: damaged }));
    expect({
      health: player.ship.health,
      cargo: player.cargo,
      purchases: player.purchases,
      maxHealth: player.ship.maxHealth,
      exploding: player.ship.exploding,
    }).toEqual({
      health: regeneratedHealth,
      cargo: 0,
      purchases: [],
      maxHealth: 100,
      exploding: false,
    });
  });

  test('an expired enhanced session replaces its cached identity before a fresh join', async () => {
    const player = createPlayer({
      name: 'Runtime pilot',
      type: 'local',
      position: { x: 500, y: 100 },
      kitId: 'scout',
    });
    vi.spyOn(PlayerManager.getInstance(), 'getLocalPlayer').mockReturnValue(player);
    const ws = await connect();
    const oldId = manager.getClientId();
    ws.receive('joined', {
      id: oldId,
      name: 'Runtime pilot',
      position: player.ship.position,
      snapshotVersion: SNAPSHOT_VERSION,
      asteroidInteractions: 1,
      terrainSeed: 7,
      resumeToken: 'a'.repeat(64),
    });
    const state = captureSnapshot(snapshotFixture());
    const oldEntity = state.entities[0];
    assert.ok(oldEntity, 'expired session entity');
    state.entities = [oldEntity];
    Object.assign(oldEntity, {
      id: oldId,
      name: 'Runtime pilot',
      playerMotion: { epoch: 1, mode: 'free', ack: 0 },
    });
    state.asteroids = [];
    state.loot = [];
    state.satellitePickups = [];
    ws.receive('snapshot', new SnapshotEncoder(state).encode(1));
    expect(manager.getAllPlayers()).toEqual([player]);
    const { getSpiderField, setSpiderField } = await import(
      '../../../src/physics/terrain/spiderSession'
    );
    setSpiderField({
      nests: [{ id: '0,0', resourceId: 'ore', cleared: false, position: { x: 5000, y: 5000 } }],
      spiders: [
        {
          id: 'expired-spider',
          position: { x: 2000, y: 0 },
          angle: 0,
          health: 75,
          maxHealth: 75,
          phase: 'hunting',
          targetId: oldId,
        },
      ],
    });
    ws.receive('sessionExpired', {});
    expect(getSpiderField()).toEqual({ spiders: [], nests: [] });
    const freshJoin = ws.sent.filter((message) => message.type === 'join').at(-1);
    assert.ok(freshJoin, 'fresh join message');
    const freshId = freshJoin.id;
    assert.ok(freshId, 'fresh client id');
    expect(freshId).not.toBe(oldId);
    expect(freshJoin.data).not.toHaveProperty('resumeToken');
    expect(manager.getAllPlayers().find((candidate) => candidate.id === oldId)).toBeUndefined();
    expect(manager.getLocalPlayerId()).toBe(freshId);
    ws.receive('joined', {
      id: freshId,
      name: 'Runtime pilot',
      position: player.ship.position,
      snapshotVersion: SNAPSHOT_VERSION,
      asteroidInteractions: 1,
      terrainSeed: 7,
      resumeToken: 'b'.repeat(64),
    });
    const freshEntity = state.entities[0];
    assert.ok(freshEntity, 'fresh session entity');
    freshEntity.id = freshId;
    ws.receive('snapshot', new SnapshotEncoder(state).encode(1));
    expect(manager.getAllPlayers()).toEqual([player]);
    expect(manager.getAllPlayers().find((candidate) => candidate.id === freshId)).toBe(player);
    expect(manager.getAllPlayers().find((candidate) => candidate.id === oldId)).toBeUndefined();
    expect(player.id).toBe(freshId);
    expect(manager.getLocalPlayerId()).toBe(freshId);
  });

  test('the client always offers the current snapshot and asteroid interaction protocol', async () => {
    const ws = await connect();
    const initialJoin = ws.sent.find((m) => m.type === 'join');
    assert.ok(initialJoin, 'initial join message');
    const initialJoinData = initialJoin.data;
    assert.ok(initialJoinData, 'initial join data');
    expect(initialJoinData.snapshotVersion).toBe(SNAPSHOT_VERSION);
    expect(initialJoinData.asteroidInteractions).toBe(1);
    expect(initialJoinData['clientReleaseId']).toMatch(CLIENT_RELEASE_ID_PATTERN);
    expect(new URL(ws.url).searchParams.get('snapshotVersion')).toBe(String(SNAPSHOT_VERSION));
    expect(new URL(ws.url).searchParams.get('asteroidInteractions')).toBe('1');
    if (initialJoinData.resumeToken !== undefined) {
      expect(initialJoinData.resumeToken).toMatch(RESUME_TOKEN_PATTERN);
    }
    acknowledge(ws);
  });

  test('malformed JSON fails at the real message callback without retiring the socket', async () => {
    const errorLog = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const ws = await connect();

    ws.receiveRaw('{"type":');

    expect(errorLog).toHaveBeenCalledWith(
      'NETWORK',
      'Failed to parse server message',
      expect.objectContaining({ name: 'SyntaxError' })
    );
    expect(ws.close).not.toHaveBeenCalled();
    expect(manager.isConnected).toBe(true);
  });

  test('an unknown typed envelope reaches dispatch without retiring the socket', async () => {
    const debugLog = vi.spyOn(logger, 'debug').mockImplementation(() => undefined);
    const ws = await connect();

    ws.receiveRaw('{"type":"futureServerEvent","data":{"value":1}}');

    expect(debugLog).toHaveBeenCalledWith('NETWORK', 'Unhandled server message type', {
      type: 'futureServerEvent',
    });
    expect(ws.close).not.toHaveBeenCalled();
    expect(manager.isConnected).toBe(true);
  });

  test('a snapshot before the first join acknowledgment fails the current protocol', async () => {
    const errorLog = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const ws = await connect();
    const frame = new SnapshotEncoder(captureSnapshot(snapshotFixture())).encode(1);

    ws.receiveRaw(JSON.stringify({ type: 'snapshot', data: frame, timestamp: 1 }));

    expect(errorLog).toHaveBeenCalledWith(
      'STATE',
      'snapshot_rejected',
      expect.objectContaining({ message: expect.stringMatching(JOIN_ACK_ORDER_ERROR_PATTERN) }),
      expect.objectContaining({
        lastAcceptedSequence: 0,
        expectedSequence: 1,
        receivedSequence: 1,
        receivedKind: 'keyframe',
      })
    );
    expect(ws.close).toHaveBeenCalled();
    expect(manager.isConnected).toBe(false);
    expect(manager.getAllPlayers()).toEqual([]);
    expect(ws.sent.filter((message) => message.type === 'snapshotAck')).toEqual([]);
  });

  test('real decoder applies keyframes/deltas, clears effects/empty worlds and survives malformed frames atomically', async () => {
    const errorLog = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const ws = await connect();
    acknowledge(ws);
    const removed: string[] = [];
    const liveBelt = new Map<string, AsteroidData>();
    bindAsteroidFieldApply({
      readBelt: () => [...liveBelt.values()],
      onCreated: (row) => {
        liveBelt.set(row.id, row);
      },
      onUpdated: () => {},
      onDestroyed: () => {},
      onReconciled: (id) => {
        liveBelt.delete(id);
        removed.push(id);
      },
    });
    const first = captureSnapshot(snapshotFixture());
    const firstPilot = first.entities[1];
    assert.ok(firstPilot, 'first pilot entity');
    firstPilot.harpoonTargetId = 'asteroid-1';
    firstPilot.harpoonLatchPos = { x: 1, y: 2 };
    firstPilot.name = 'Runtime pilot'; // Display names are not session identities.
    firstPilot.kitId = 'hauler';
    ws.receive('snapshot', new SnapshotEncoder(first).encode(1));
    expect(
      manager.getAllPlayers().find((candidate) => candidate.id === 'pilot-1')?.ship.harpoonTargetId
    ).toBe('asteroid-1');
    expect(ws.sent.filter((message) => message.type === 'snapshotAck')).toEqual([
      { type: 'snapshotAck', data: { sequence: 1 } },
    ]);
    const next = captureSnapshot(snapshotFixture(1));
    next.asteroids = [];
    next.loot = [];
    next.entities.pop();
    const nextPilot = next.entities[1];
    assert.ok(nextPilot, 'next pilot entity');
    delete nextPilot.kitId;
    nextPilot.name = 'Renamed pilot';
    const delta = new SnapshotEncoder(next).encode(2, { sequence: 1, state: first });
    ws.receive('snapshot', { ...delta, sequence: 8 });
    expect(manager.getAllPlayers()).toHaveLength(10);
    expect(LootField.getInstance().getAll()).toHaveLength(15);
    expect(ws.sent.filter((m) => m.type === 'snapshotResync')).toHaveLength(1);
    expect(ws.sent.filter((message) => message.type === 'snapshotAck')).toHaveLength(1);
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
    expect(
      manager.getAllPlayers().find((candidate) => candidate.id === 'pilot-1')?.ship.harpoonTargetId
    ).toBeNull();
    expect(
      manager.getAllPlayers().find((candidate) => candidate.id === 'pilot-1')?.ship.harpoonLatchPos
    ).toBeUndefined();
    expect(
      manager.getAllPlayers().find((candidate) => candidate.id === 'pilot-1')?.ship.kitId
    ).toBe('scout');
    expect(manager.getAllPlayers().find((candidate) => candidate.id === 'pilot-1')?.name).toBe(
      'Renamed pilot'
    );
    expect(removed).toHaveLength(80);
    expect(LootField.getInstance().getAll()).toEqual([]);
    expect(ws.sent.filter((message) => message.type === 'snapshotAck')).toEqual([
      { type: 'snapshotAck', data: { sequence: 1 } },
      { type: 'snapshotAck', data: { sequence: 2 } },
    ]);
    ws.receive('snapshot', new SnapshotEncoder(first).encode(20));
    expect(manager.getAllPlayers()).toHaveLength(10);
    expect(LootField.getInstance().getAll()).toEqual(first.loot);
    expect(ws.sent.filter((message) => message.type === 'snapshotAck').at(-1)).toEqual({
      type: 'snapshotAck',
      data: { sequence: 20 },
    });
  });

  test('a decoded world earns no application credit when a snapshot consumer fails', async () => {
    vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const ws = await connect();
    acknowledge(ws);
    const first = captureSnapshot(snapshotFixture());
    ws.receive('snapshot', new SnapshotEncoder(first).encode(1));
    bindAsteroidFieldApply({
      readBelt: () => first.asteroids,
      onCreated: () => {},
      onUpdated: () => {},
      onDestroyed: () => {},
      onReconciled: () => {
        throw new Error('Unable to reconcile a visible asteroid');
      },
    });
    const next = captureSnapshot(snapshotFixture(1));
    next.asteroids = [];
    ws.receive('snapshot', new SnapshotEncoder(next).encode(2, { sequence: 1, state: first }));
    expect(ws.sent.filter((message) => message.type === 'snapshotAck')).toEqual([
      { type: 'snapshotAck', data: { sequence: 1 } },
    ]);
    expect(ws.sent.filter((message) => message.type === 'snapshotResync')).toHaveLength(1);
    unbindAsteroidFieldApply();
    ws.receive('snapshot', new SnapshotEncoder(next).encode(3));
    expect(ws.sent.filter((message) => message.type === 'snapshotAck').at(-1)).toEqual({
      type: 'snapshotAck',
      data: { sequence: 3 },
    });
  });

  test('join snapshots replace cold, warm and restarted asteroid fields without initialization requests', async () => {
    const belt = new Map<string, Roid>();
    function create(row: AsteroidData) {
      belt.set(row.id, new Roid(row));
    }
    bindAsteroidFieldApply({
      readBelt: () => [...belt.values()],
      onCreated: create,
      onUpdated: (id, row) => {
        const rock = belt.get(id);
        if (rock) {
          applyAsteroidKinematics(rock, row);
        }
      },
      onDestroyed: (event) => belt.delete(event.asteroidId),
      onReconciled: (id) => belt.delete(id),
    });
    let ws = await connect();
    acknowledge(ws);
    const first = captureSnapshot(snapshotFixture());
    const firstRock = first.asteroids[0];
    assert.ok(firstRock);
    first.asteroids = [firstRock];
    ws.receive('snapshot', new SnapshotEncoder(first).encode(1));
    expect([...belt.keys()]).toEqual([firstRock.id]);
    const warmRock = belt.get(firstRock.id);
    const retainedPickup = SatellitePickupManager.getInstance().getAll()[0];
    const retainedLoot = LootField.getInstance().getAll();

    ws.close();
    ws = await connect();
    acknowledge(ws);
    expect(belt.get(firstRock.id)).toBe(warmRock);
    expect(SatellitePickupManager.getInstance().getAll()[0]).toBe(retainedPickup);
    expect(LootField.getInstance().getAll()).toEqual(retainedLoot);
    const moved = captureSnapshot(first);
    const movedRock = moved.asteroids[0];
    assert.ok(movedRock);
    movedRock.position = { x: 240, y: -120 };
    ws.receive('snapshot', new SnapshotEncoder(moved).encode(1));
    expect(belt.get(firstRock.id)).toBe(warmRock);
    expect(warmRock?.position).toEqual({ x: 240, y: -120 });

    // A fresh process starts sequence 1 with a different nearby sector.
    ws.close();
    ws = await connect();
    acknowledge(ws);
    const restarted = captureSnapshot(first);
    restarted.asteroids = [{ ...firstRock, id: 'new-sector-rock', position: { x: -400, y: 200 } }];
    ws.receive('snapshot', new SnapshotEncoder(restarted).encode(1));
    expect([...belt.keys()]).toEqual(['new-sector-rock']);
    expect(belt.get('new-sector-rock')?.position).toEqual({ x: -400, y: 200 });

    const empty = captureSnapshot(restarted);
    empty.asteroids = [];
    ws.receive('snapshot', new SnapshotEncoder(empty).encode(2, { sequence: 1, state: restarted }));
    expect([...belt.keys()]).toEqual([]);
    expect(ws.sent.filter((message) => message.type === 'initAsteroids')).toEqual([]);
    expect(ws.sent.filter((message) => message.type === 'snapshotResync')).toEqual([]);
    expect(ws.sent.filter((message) => message.type === 'snapshotAck')).toEqual([
      { type: 'snapshotAck', data: { sequence: 1 } },
      { type: 'snapshotAck', data: { sequence: 2 } },
    ]);
  });

  test('create batches reject incomplete and invalid rows before constructing fragments', async () => {
    const ws = await connect();
    acknowledge(ws);
    const created = vi.fn();
    bindAsteroidFieldApply({
      readBelt: () => [],
      onCreated: created,
      onUpdated: () => {},
      onDestroyed: () => {},
      onReconciled: () => {},
    });
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const fragment = snapshotFixture().asteroids[0];
    assert.ok(fragment);
    const complete = { ...fragment, id: 'fragment', ore: 'metal', surveyedBy: ['scout'] };
    ws.receive('asteroidCreateBatch', {
      asteroids: [
        { id: 'incomplete' },
        { ...fragment, id: 'invalid', material: 'plasma' },
        complete,
      ],
    });
    expect(created).toHaveBeenCalledExactlyOnceWith(complete);
    expect(error).toHaveBeenCalledWith(
      'NETWORK',
      'Rejected invalid asteroid create row',
      undefined,
      { asteroidId: 'incomplete' }
    );
    expect(error).toHaveBeenCalledWith(
      'NETWORK',
      'Rejected invalid asteroid create row',
      undefined,
      { asteroidId: 'invalid' }
    );
    LootField.getInstance().applySnapshot(snapshotFixture().loot);
    SatellitePickupManager.getInstance().syncFromServer(snapshotFixture().satellitePickups ?? []);
    manager.disconnect({ newSession: true });
    expect(LootField.getInstance().getAll()).toEqual([]);
    expect(SatellitePickupManager.getInstance().getAll()).toEqual([]);
  });

  test('pickup ownership and asteroid metadata reconcile in real managers', async () => {
    const ws = await connect();
    acknowledge(ws);
    const belt = new Map<string, Roid>();
    function create(row: AsteroidData) {
      const roid = new Roid(row);
      belt.set(row.id, roid);
    }
    bindAsteroidFieldApply({
      readBelt: () => [...belt.values()],
      onCreated: create,
      onUpdated: (id, row) => {
        const rock = belt.get(id);
        if (rock) {
          applyAsteroidKinematics(rock, row);
        }
      },
      onDestroyed: (event) => {
        belt.delete(event.asteroidId);
      },
      onReconciled: (id) => {
        belt.delete(id);
      },
    });
    const first = captureSnapshot(snapshotFixture());
    ws.receive('snapshot', new SnapshotEncoder(first).encode(1));
    const pickups = SatellitePickupManager.getInstance();
    expect(pickups.getAll()).toHaveLength(6);
    expect(pickups.get('pickup-0')?.ownerId).toBe('pilot-0');
    const next = captureSnapshot(snapshotFixture(70));
    const damagedPickup = next.satellitePickups[0];
    assert.ok(damagedPickup, 'damaged pickup');
    damagedPickup.health = 25;
    const nextAsteroid = next.asteroids[0];
    assert.ok(nextAsteroid, 'next asteroid');
    nextAsteroid.material = 'rubble';
    nextAsteroid.vertices = 3;
    nextAsteroid.offsets = [0.7, 1.2, 0.8];
    nextAsteroid.jaggedness = 0.9;
    ws.receive('snapshot', new SnapshotEncoder(next).encode(2, { sequence: 1, state: first }));
    expect(pickups.get('pickup-0')?.ownerId).toBeNull();
    expect(pickups.get('pickup-0')?.health).toBe(25);
    expect(belt.get('asteroid-0')).toMatchObject({
      material: 'rubble',
      offsets: [0.7, 1.2, 0.8],
      vertices: 3,
      jaggedness: 0.9,
    });
    // A rejoin starts a new sequence and reconstructs ownership even after local caches were lost.
    manager.initializeAsteroidSync();
    acknowledge(ws);
    pickups.clear();
    ws.receive('snapshot', new SnapshotEncoder(first).encode(1));
    expect(pickups.get('pickup-0')?.ownerId).toBe('pilot-0');
  });

  test('local Hauler prediction follows authoritative attach and release snapshots', async () => {
    setSelectedShipKitId('hauler');
    const player = createPlayer({
      name: 'Runtime pilot',
      type: 'local',
      position: { x: 500, y: 100 },
      kitId: 'hauler',
    });
    vi.spyOn(PlayerManager.getInstance(), 'getLocalPlayer').mockReturnValue(player);
    const ws = await connect();
    acknowledge(ws);
    const zero = captureSnapshot(snapshotFixture());
    const zeroEntity = zero.entities[0];
    assert.ok(zeroEntity, 'zero snapshot entity');
    zeroEntity.id = manager.getClientId();
    zeroEntity.kitId = 'hauler';
    Object.assign(zeroEntity, {
      harpoonTargetId: 'asteroid-1',
      harpoonLatchPos: { x: 1, y: 2 },
      abilityActiveFrames: 30,
      abilityCooldownFrames: 80,
    });
    ws.receive('snapshot', new SnapshotEncoder(zero).encode(1));
    expect(player.ship.harpoonTargetId).toBe('asteroid-1');
    expect(player.ship.harpoonLatchPos).toEqual({ x: 1, y: 2 });
    expect(player.ship.abilityActiveFrames).toBe(30);
    const active = captureSnapshot(zero);
    const activeEntity = active.entities[0];
    assert.ok(activeEntity, 'active snapshot entity');
    Object.assign(activeEntity, {
      harpoonTargetId: 'asteroid-1',
      harpoonLatchPos: { x: 3, y: 4 },
      abilityActiveFrames: 28,
      abilityCooldownFrames: 78,
    });
    ws.receive('snapshot', new SnapshotEncoder(active).encode(2));
    expect(player.ship.harpoonTargetId).toBe('asteroid-1');
    expect(player.ship.harpoonLatchPos).toEqual({ x: 3, y: 4 });
    expect(player.ship.abilityActiveFrames).toBe(28);
    const released = captureSnapshot(active);
    const releasedEntity = released.entities[0];
    assert.ok(releasedEntity, 'released entity');
    releasedEntity.harpoonTargetId = null;
    delete releasedEntity.harpoonLatchPos;
    releasedEntity.abilityActiveFrames = 0;
    ws.receive('snapshot', new SnapshotEncoder(released).encode(3));
    expect(player.ship.harpoonTargetId).toBeNull();
    expect(player.ship.harpoonLatchPos).toBeUndefined();
    expect(player.ship.abilityActiveFrames).toBe(0);
  });

  test('a stale snapshot preserves predicted Mineral Scan until the server echo, then accepts its end', async () => {
    const player = createPlayer({
      name: 'Runtime pilot',
      type: 'local',
      position: { x: 500, y: 100 },
      kitId: 'scout',
      combatNetwork: manager.combatNetwork,
    });
    vi.spyOn(PlayerManager.getInstance(), 'getLocalPlayer').mockReturnValue(player);
    const ws = await connect();
    acknowledge(ws);
    const zero = captureSnapshot(snapshotFixture());
    const zeroEntity = zero.entities[0];
    assert.ok(zeroEntity, 'zero snapshot entity');
    zeroEntity.id = manager.getClientId();
    zeroEntity.kitId = 'scout';
    zeroEntity.abilityCooldownFrames = 0;
    ws.receive('snapshot', new SnapshotEncoder(zero).encode(1));
    player.ship.scoutUtility = 'mineral_scan';
    expect(player.ship.activateAbility()).toBe(true);
    expect(ws.sent.at(-1)?.type).toBe('useAbility');
    expect(player.ship.abilityActiveFrames).toBe(SHIP_ABILITY.SCAN_FRAMES);
    const stale = captureSnapshot(zero);
    const staleEntity = stale.entities[0];
    assert.ok(staleEntity, 'stale snapshot entity');
    staleEntity.abilityCooldownFrames = 0;
    ws.receive('snapshot', new SnapshotEncoder(stale).encode(2));
    expect(player.ship.abilityCooldownFrames).toBe(SHIP_ABILITY.COOLDOWN_FRAMES.scout);
    expect(player.ship.abilityActiveFrames).toBe(SHIP_ABILITY.SCAN_FRAMES);
    const echoed = captureSnapshot(stale);
    const echoedEntity = echoed.entities[0];
    assert.ok(echoedEntity, 'echoed snapshot entity');
    echoedEntity.abilityCooldownFrames = SHIP_ABILITY.COOLDOWN_FRAMES.scout - 4;
    echoedEntity.abilityActiveFrames = SHIP_ABILITY.SCAN_FRAMES - 4;
    ws.receive('snapshot', new SnapshotEncoder(echoed).encode(3));
    expect(player.ship.abilityCooldownFrames).toBe(SHIP_ABILITY.COOLDOWN_FRAMES.scout - 4);
    expect(player.ship.abilityActiveFrames).toBe(SHIP_ABILITY.SCAN_FRAMES - 4);
    const ended = captureSnapshot(echoed);
    const endedEntity = ended.entities[0];
    assert.ok(endedEntity, 'ended snapshot entity');
    endedEntity.abilityCooldownFrames =
      SHIP_ABILITY.COOLDOWN_FRAMES.scout - SHIP_ABILITY.SCAN_FRAMES;
    endedEntity.abilityActiveFrames = 0;
    ws.receive('snapshot', new SnapshotEncoder(ended).encode(4));
    expect(player.ship.abilityActiveFrames).toBe(0);
  });

  test.each(['downed', 'exploding', 'locally predicted death'])(
    'a Scan rejected during %s stays cancelled through respawn',
    async (death) => {
      vi.spyOn(Date, 'now').mockReturnValue(123_000);
      const player = createPlayer({
        name: 'Runtime pilot',
        type: 'local',
        position: { x: 500, y: 100 },
        kitId: 'scout',
        combatNetwork: manager.combatNetwork,
      });
      vi.spyOn(PlayerManager.getInstance(), 'getLocalPlayer').mockReturnValue(player);
      const ws = await connect();
      acknowledge(ws);
      const ready = captureSnapshot(snapshotFixture());
      const readyEntity = ready.entities[0];
      assert.ok(readyEntity, 'ready snapshot entity');
      readyEntity.id = manager.getClientId();
      readyEntity.kitId = 'scout';
      ws.receive('snapshot', new SnapshotEncoder(ready).encode(1));
      player.ship.scoutUtility = 'mineral_scan';
      expect(player.ship.activateAbility()).toBe(true);
      expect(ws.sent.at(-1)?.type).toBe('useAbility');
      expect(scanCameraZoom(player.ship, 800, 1094)).toBeLessThan(1);

      if (death === 'locally predicted death') {
        // Death and respawn may happen between received snapshots.
        player.ship.takeDamage(player.ship.maxHealth);
      } else {
        // The server rejects the in-flight request after the pilot dies,
        // so it never starts either authoritative ability timer.
        const rejected = captureSnapshot(ready);
        const rejectedEntity = rejected.entities[0];
        assert.ok(rejectedEntity, 'rejected snapshot entity');
        rejectedEntity.health = 0;
        rejectedEntity.exploding = death === 'exploding';
        rejectedEntity.downedUntil = death === 'downed' ? 183_000 : null;
        ws.receive('snapshot', new SnapshotEncoder(rejected).encode(2));
        expect(player.ship.abilityActiveFrames).toBe(0);
        expect(player.ship.abilityCooldownFrames).toBe(0);
      }
      expect(player.ship.health).toBe(0);
      expect(scanCameraZoom(player.ship, 800, 1094)).toBe(1);
      for (let frame = 0; frame < SHIP_ABILITY.SCAN_FRAMES; frame++) {
        player.ship.updateLifecycle();
      }

      const revived = captureSnapshot(ready);
      const revivedEntity = revived.entities[0];
      assert.ok(revivedEntity, 'respawn snapshot entity');
      revivedEntity.spawnProtectionTimer = 60;
      ws.receive('snapshot', new SnapshotEncoder(revived).encode(3));
      expect(player.ship.health).toBe(player.ship.maxHealth);
      expect(player.ship.exploding).toBe(false);
      expect(player.ship.abilityActiveFrames).toBe(0);
      expect(player.ship.abilityCooldownFrames).toBe(0);
      expect(scanCameraZoom(player.ship, 800, 1094)).toBe(1);
      expect(player.ship.activateAbility()).toBe(true);
      expect(player.ship.abilityActiveFrames).toBe(SHIP_ABILITY.SCAN_FRAMES);
    }
  );

  test('a probe miss snapshot keeps the Scout ability ready', async () => {
    const player = createPlayer({
      name: 'Runtime pilot',
      type: 'local',
      position: { x: 500, y: 100 },
      kitId: 'scout',
    });
    vi.spyOn(PlayerManager.getInstance(), 'getLocalPlayer').mockReturnValue(player);
    const ws = await connect();
    acknowledge(ws);
    const zero = captureSnapshot(snapshotFixture());
    const zeroEntity = zero.entities[0];
    assert.ok(zeroEntity, 'zero snapshot entity');
    zeroEntity.id = manager.getClientId();
    zeroEntity.kitId = 'scout';
    zeroEntity.equipment = ['survey_probe'];
    zeroEntity.scoutUtility = 'survey_probe';
    zeroEntity.abilityCooldownFrames = 0;
    ws.receive('snapshot', new SnapshotEncoder(zero).encode(1));
    player.ship.scoutUtility = 'survey_probe';
    player.ship.abilityCooldownFrames = SHIP_ABILITY.COOLDOWN_FRAMES.scout;
    const miss = captureSnapshot(zero);
    const missEntity = miss.entities[0];
    assert.ok(missEntity, 'miss snapshot entity');
    missEntity.abilityCooldownFrames = 0;
    ws.receive('snapshot', new SnapshotEncoder(miss).encode(2));
    expect(player.ship.abilityCooldownFrames).toBe(0);
  });

  test('unacked Hauler tow survives an empty-belt snapshot while the held rock remains', async () => {
    setSelectedShipKitId('hauler');
    const player = createPlayer({
      name: 'Runtime pilot',
      type: 'local',
      position: { x: 500, y: 100 },
      kitId: 'hauler',
    });
    vi.spyOn(PlayerManager.getInstance(), 'getLocalPlayer').mockReturnValue(player);
    const ws = await connect();
    acknowledge(ws);
    const zero = captureSnapshot(snapshotFixture());
    const zeroEntity = zero.entities[0];
    assert.ok(zeroEntity, 'zero snapshot entity');
    zeroEntity.id = manager.getClientId();
    zeroEntity.kitId = 'hauler';
    ws.receive('snapshot', new SnapshotEncoder(zero).encode(1));
    publishHarpoonField([{ id: 'asteroid-1', position: { x: 1, y: 2 }, velocity: { x: 0, y: 0 } }]);
    Object.assign(player.ship, {
      harpoonTargetId: 'asteroid-1',
      harpoonLatchPos: { x: 1, y: 2 },
      abilityActiveFrames: 30,
      abilityCooldownFrames: 80,
    });
    manager.sendMessage({ type: 'useAbility', id: manager.getLocalPlayerId(), data: {} });
    const emptyBelt = captureSnapshot(zero);
    emptyBelt.asteroids = [];
    ws.receive('snapshot', new SnapshotEncoder(emptyBelt).encode(2));
    expect(player.ship.harpoonTargetId).toBe('asteroid-1');
    expect(player.ship.harpoonLatchPos).toEqual({ x: 1, y: 2 });
  });

  test('socket closure releases the contour and resume stays unlocked', async () => {
    const player = createPlayer({
      name: 'Runtime pilot',
      type: 'local',
      position: { x: 500, y: 100 },
      kitId: 'scout',
    });
    vi.spyOn(PlayerManager.getInstance(), 'getLocalPlayer').mockReturnValue(player);
    vi.spyOn(PlayerManager.getInstance(), 'getLocalShip').mockReturnValue(player.ship);
    let ws = await connect();
    acknowledge(ws);
    player.ship.contourLock = { height: 0.08, direction: 1 };

    ws.close();
    expect(player.ship.contourLock).toBeNull();
    ws = await connect();
    acknowledge(ws);
    expect(player.ship.contourLock).toBeNull();
    const snapshot = captureSnapshot(snapshotFixture());
    const entity = snapshot.entities[0];
    assert.ok(entity);
    entity.id = manager.getClientId();
    delete entity.contourLock;
    entity.playerMotion = { epoch: 1, mode: 'free', ack: 0 };
    ws.receive('snapshot', new SnapshotEncoder(snapshot).encode(1));
    expect(player.ship.contourLock).toBeNull();
    expect(ws.sent.filter((message) => message.type === 'snapshotAck')).toEqual([
      { type: 'snapshotAck', data: { sequence: 1 } },
    ]);
  });

  test('socket-flap Hauler visuals clear on an authoritative release', async () => {
    setSelectedShipKitId('hauler');
    const player = createPlayer({
      name: 'Runtime pilot',
      type: 'local',
      position: { x: 500, y: 100 },
      kitId: 'hauler',
    });
    vi.spyOn(PlayerManager.getInstance(), 'getLocalPlayer').mockReturnValue(player);
    let ws = await connect();
    acknowledge(ws);
    const active = captureSnapshot(snapshotFixture());
    const reconnectedActiveEntity = active.entities[0];
    assert.ok(reconnectedActiveEntity, 'reconnected active entity');
    Object.assign(reconnectedActiveEntity, {
      id: manager.getClientId(),
      kitId: 'hauler',
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
    zeroActiveEntity.abilityActiveFrames = 0;
    zeroActiveEntity.harpoonTargetId = null;
    delete zeroActiveEntity.harpoonLatchPos;
    ws.receive('snapshot', new SnapshotEncoder(zero).encode(1));
    expect(player.ship.harpoonTargetId).toBeNull();
    expect(player.ship.harpoonLatchPos).toBeUndefined();
    // A warm prediction also stops immediately when the server releases it.
    Object.assign(player.ship, {
      harpoonTargetId: 'asteroid-1',
      harpoonLatchPos: { x: 1, y: 2 },
    });
    const removed = captureSnapshot(zero);
    removed.asteroids = removed.asteroids.filter((rock) => rock.id !== 'asteroid-1');
    const removedEntity = removed.entities[0];
    assert.ok(removedEntity, 'removed target entity');
    removedEntity.harpoonTargetId = null;
    delete removedEntity.harpoonLatchPos;
    ws.receive('snapshot', new SnapshotEncoder(removed).encode(4));
    expect(player.ship.harpoonTargetId).toBeNull();
    expect(player.ship.harpoonLatchPos).toBeUndefined();
    expect(ws.sent.filter((message) => message.type === 'useAbility')).toHaveLength(0);
  });

  test('rejoin acknowledges in-flight worlds while gameplay waits for its fresh baseline', async () => {
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
    queuedPilot.health = 23;
    ws.receive('snapshot', new SnapshotEncoder(queued).encode(16, { sequence: 15, state }));
    expect(ws.close).not.toHaveBeenCalled();
    expect(
      manager.getAllPlayers().find((candidate) => candidate.id === 'pilot-1')?.ship.health
    ).toBe(23);
    expect(ws.sent.filter((message) => message.type === 'snapshotAck').at(-1)).toEqual({
      type: 'snapshotAck',
      data: { sequence: 16 },
    });
    expect(manager.sendMessage({ type: 'useAbility', id: 'pilot-1', data: {} })).toBe(false);
    acknowledge(ws);
    ws.receive('snapshot', new SnapshotEncoder(state).encode(17));
    const statePilot = state.entities[1];
    assert.ok(statePilot, 'state pilot entity');
    expect(
      manager.getAllPlayers().find((candidate) => candidate.id === 'pilot-1')?.ship.health
    ).toBe(statePilot.health);
    expect(ws.close).not.toHaveBeenCalled();
    expect(ws.sent.filter((message) => message.type === 'snapshotAck').at(-1)).toEqual({
      type: 'snapshotAck',
      data: { sequence: 17 },
    });
  });

  test('rejoin can recover a rejected queued world while gameplay is waiting for joined', async () => {
    vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const ws = await connect();
    acknowledge(ws);
    const state = captureSnapshot(snapshotFixture());
    ws.receive('snapshot', new SnapshotEncoder(state).encode(15));
    manager.initializeAsteroidSync();
    const queued = new SnapshotEncoder(state).encode(16, { sequence: 15, state });
    assert.equal(queued.kind, 'delta');
    ws.receive('snapshot', { ...queued, baseline: 14 });
    expect(ws.sent.filter((message) => message.type === 'snapshotAck')).toEqual([
      { type: 'snapshotAck', data: { sequence: 15 } },
    ]);
    expect(ws.sent.filter((message) => message.type === 'snapshotResync')).toEqual([
      { type: 'snapshotResync', data: {} },
    ]);
    expect(manager.sendMessage({ type: 'useAbility', id: 'pilot-1', data: {} })).toBe(false);
    acknowledge(ws);
    ws.receive('snapshot', new SnapshotEncoder(state).encode(17));
    expect(ws.sent.filter((message) => message.type === 'snapshotAck').at(-1)).toEqual({
      type: 'snapshotAck',
      data: { sequence: 17 },
    });
    expect(ws.close).not.toHaveBeenCalled();
  });

  test('an existing pilot retries after a previous-version server rejects negotiation without losing its credential', async () => {
    let ws = await connect();
    acknowledge(ws);
    const id = manager.getClientId();
    manager.disconnect();
    ws = await connect();
    expect(ws.sent.find((message) => message.type === 'join')?.data).toMatchObject({
      resumeToken: 'a'.repeat(64),
    });
    ws.receive('joined', {
      id,
      name: 'Runtime pilot',
      position: { x: 0, y: 0 },
      snapshotVersion: 2,
      asteroidInteractions: 1,
      terrainSeed: 7,
      resumeToken: 'b'.repeat(64),
    });
    expect(ws.close).toHaveBeenCalled();
    expect(manager.getClientId()).toBe(id);
    ws = await connect();
    expect(ws.sent.find((message) => message.type === 'join')?.data).toMatchObject({
      resumeToken: 'a'.repeat(64),
    });
    acknowledge(ws);
    expect(manager.isConnected).toBe(true);
    expect(manager.getClientId()).toBe(id);
  });

  test.each([
    {
      label: 'previous snapshot version',
      snapshotVersion: 2,
      asteroidInteractions: 1,
      resumeToken: 'a'.repeat(64),
      terrainSeed: 7,
    },
    {
      label: 'future snapshot version',
      snapshotVersion: SNAPSHOT_VERSION + 1,
      asteroidInteractions: 1,
      resumeToken: 'a'.repeat(64),
      terrainSeed: 7,
    },
    {
      label: 'asteroid interaction capability',
      snapshotVersion: SNAPSHOT_VERSION,
      asteroidInteractions: 2,
      resumeToken: 'a'.repeat(64),
      terrainSeed: 7,
    },
    {
      label: 'resume token',
      snapshotVersion: SNAPSHOT_VERSION,
      asteroidInteractions: 1,
      resumeToken: 'short',
      terrainSeed: 7,
    },
    {
      label: 'terrain seed',
      snapshotVersion: SNAPSHOT_VERSION,
      asteroidInteractions: 1,
      resumeToken: 'a'.repeat(64),
    },
    {
      label: 'numeric terrain seed',
      snapshotVersion: SNAPSHOT_VERSION,
      asteroidInteractions: 1,
      resumeToken: 'a'.repeat(64),
      terrainSeed: 'seven',
    },
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
    expect(manager.isConnected).toBe(false);
  });
});
