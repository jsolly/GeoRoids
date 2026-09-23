import { strict as assert } from 'node:assert';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { observesPreparedFixture } from '../../../benchmarks/fixture-readiness';
import { calculateHealthRegenPerFrame } from '../../../shared/constants/health';
import { captureSnapshot, SnapshotEncoder } from '../../../shared/snapshotProtocol';
import type { AsteroidData } from '../../../shared-types';
import { Sound, setSound } from '../../../src/audio/Sound';
import { bindGameAudio, resetGameAudio } from '../../../src/audio/spatialAudio';
import { clientPerformance } from '../../../src/diagnostics/performanceMetrics';
import { entityFactory } from '../../../src/entities/EntityFactory';
import { LootField } from '../../../src/entities/loot/LootField';
import type { Player } from '../../../src/entities/player/Player';
import { PlayerManager } from '../../../src/entities/player/PlayerManager';
import { Roid } from '../../../src/entities/roid/Roid';
import { SatellitePickupManager } from '../../../src/entities/satellitePickup/SatellitePickupManager';
import { publishHarpoonField } from '../../../src/entities/ship/harpoonField';
import { SHIP_ABILITY } from '../../../src/entities/ship/shipKits';
import { resetControlSources } from '../../../src/input/controlSources';
import { keyDown, keyUp } from '../../../src/input/keybindings';
import { handleMouseDown, handleMouseUp } from '../../../src/input/mouse';
import { setTouchHeading } from '../../../src/input/touchControls';
import {
  applyAsteroidRowToBelt,
  bindAsteroidFieldApply,
  unbindAsteroidFieldApply,
} from '../../../src/network/services/asteroidFieldSync';
import { ConnectionManager } from '../../../src/network/services/ConnectionManager';
import { setSelectedShipKitId } from '../../../src/ui/shipKitSelect';
import { logger } from '../../../src/utils/Logger';
import { snapshotFixture } from './snapshotFixture';

const LASER_SOUND_PATH_PATTERN = /sounds\/laser\.m4a$/u;
const LOOT_PICKUP_SOUND_PATH_PATTERN = /sounds\/loot-pickup\.m4a$/u;
const SURVEY_SCAN_SOUND_PATH_PATTERN = /survey-scan\.m4a$/u;
const ORBITAL_PICKUP_SOUND_PATH_PATTERN = /orbital-pickup\.m4a$/u;
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
      snapshotVersion: 1,
      asteroidInteractions: 1,
      resumeToken,
    });
  }

  test.each([1, 7])('a returning pilot moves after its saved epoch %i restarts', async (epoch) => {
    const player = entityFactory.createLocalPlayer('Runtime pilot', { x: 0, y: 0 }, 'scout');
    vi.spyOn(PlayerManager.getInstance(), 'getLocalPlayer').mockReturnValue(player);
    vi.spyOn(PlayerManager.getInstance(), 'getLocalShip').mockReturnValue(player.ship);
    let ws = await connect();
    acknowledge(ws);
    const frame = captureSnapshot(snapshotFixture());
    const pilot = frame.entities[0];
    assert.ok(pilot);
    pilot.id = manager.getClientId();
    pilot.playerMotion = { epoch, mode: 'free', ack: 80 };
    ws.receive('snapshot', new SnapshotEncoder(frame).encode(1));

    // A hidden tab can outlive the live actor. Its private credential restores
    // the saved pilot with the same ID but a new motion session starting at 1.
    ws.close();
    ws = await connect();
    acknowledge(ws);
    pilot.playerMotion = { epoch: 1, mode: 'free', ack: 0 };
    pilot.position = { x: 2382, y: 2849 };
    ws.receive('snapshot', new SnapshotEncoder(frame).encode(1));
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
    const player = entityFactory.createLocalPlayer('Listening pilot', { x: 0, y: 0 }, 'scout');
    vi.spyOn(PlayerManager.getInstance(), 'getLocalPlayer').mockReturnValue(player);
    const ws = await connect();
    acknowledge(ws);
    ws.receive('snapshot', new SnapshotEncoder(captureSnapshot(snapshotFixture())).encode(1));
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
      ws.receive('lootCollected', { ...collection, lootId: 'invalid-kind', kind: 'unknown' });
      ws.receive('lootCollected', {
        ...collection,
        lootId: 'distant-loot',
        position: { x: 10000, y: 0 },
      });
      expect(played).toHaveLength(3);
      setSound(false);
      ws.receive('playerShotFired', {
        id: 'muted-shot',
        ownerId: 'other-pilot',
        position: { x: 30, y: 0 },
      });
      ws.receive('lootCollected', { ...collection, lootId: 'muted-loot' });
      expect(played).toHaveLength(3);
      manager.disconnect();
      const reconnected = await connect();
      acknowledge(reconnected);
      setSound(true);
      reconnected.receive('lootCollected', collection);
      expect(played).toHaveLength(3);
      reconnected.receive(
        'snapshot',
        new SnapshotEncoder(captureSnapshot(snapshotFixture())).encode(1)
      );
      reconnected.receive('lootCollected', collection);
      expect(played).toHaveLength(3);
      reconnected.receive('lootCollected', { ...collection, lootId: 'new-live-pickup' });
      expect(played).toHaveLength(4);
    } finally {
      resetGameAudio();
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
      const state = captureSnapshot(snapshotFixture());
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
    const player = entityFactory.createLocalPlayer('Hull pilot', { x: 0, y: 0 }, 'scout');
    vi.spyOn(PlayerManager.getInstance(), 'getLocalPlayer').mockReturnValue(player);
    const ws = await connect();
    acknowledge(ws);
    ws.receive('snapshot', new SnapshotEncoder(captureSnapshot(snapshotFixture())).encode(1));
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
      remainingLives: 3,
    };
    ws.receive('playerDamaged', damage);
    expect(played).toContain('/sounds/hull-damage.m4a');
    played.length = 0;
    ws.receive('playerDamaged', damage);
    expect(played).toEqual([]);
    ws.receive('playerDamaged', { ...damage, damage: 0 });
    expect(played).toEqual([]);
    setSound(false);
  });

  test('offscreen coupling ignition still confirms release at the local ship', async () => {
    const player = entityFactory.createLocalPlayer('Hauler pilot', { x: 0, y: 0 }, 'hauler');
    vi.spyOn(PlayerManager.getInstance(), 'getLocalPlayer').mockReturnValue(player);
    const ws = await connect();
    acknowledge(ws);
    ws.receive('snapshot', new SnapshotEncoder(captureSnapshot(snapshotFixture())).encode(1));
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
        boostIgnitionPosition: { x: player.ship.position.x + 250, y: player.ship.position.y },
      });
      expect(played).toEqual(['/sounds/harpoon-release.m4a']);
    } finally {
      resetGameAudio();
      setSound(false);
    }
  });

  test('a warm reconnect silently hydrates destruction before later deaths sound normally', async () => {
    const player = entityFactory.createLocalPlayer('Returning pilot', { x: 0, y: 0 }, 'scout');
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
    const player = entityFactory.createLocalPlayer('Survey pilot', { x: 0, y: 0 }, 'scout');
    vi.spyOn(PlayerManager.getInstance(), 'getLocalPlayer').mockReturnValue(player);
    const ws = await connect();
    acknowledge(ws);
    ws.receive('snapshot', new SnapshotEncoder(captureSnapshot(snapshotFixture())).encode(1));
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
      player.ship.activateAbility();
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

  test('intentional disconnect clears movement recovery after retiring the socket', async () => {
    const player = entityFactory.createLocalPlayer('Departing pilot', { x: 0, y: 0 }, 'hauler');
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
    expect(manager.isConnected()).toBe(false);
  });

  test('a new socket and join cannot reuse a departed session snapshot witness', async () => {
    const player = entityFactory.createLocalPlayer('Runtime pilot', { x: 0, y: 0 }, 'scout');
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
      source: 'touch steering',
      press: (player: Player) => setTouchHeading(player, 0),
      release: (player: Player) => setTouchHeading(player, null),
    },
  ])(
    'late Hauler snapshots preserve cruise across $source press and release',
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
        playerMotion: { epoch: 3, mode: 'free', ack: 0 },
      });
      state.entities = [local];
      state.playerProjectiles = [];
      state.collabTags = [];
      state.satellitePickups = [];
      state.loot = [];
      ws.receive('snapshot', new SnapshotEncoder(state).encode(1));
      press(player);
      expect(player.ship.thrusting).toBe(true);
      // An older echo arrives before the newly held input has been sent.
      clock.mockReturnValue(10_017);
      ws.receive('snapshot', new SnapshotEncoder(state).encode(2));
      manager.sendPlayerState({ id: player.id, ...player.getStateForNetwork() });
      expect(ws.sent.filter((message) => message.type === 'update').at(-1)?.data).toMatchObject({
        thrusting: true,
      });

      release(player);
      local.thrusting = true;
      clock.mockReturnValue(10_034);
      ws.receive('snapshot', new SnapshotEncoder(state).encode(3));
      manager.sendPlayerState({ id: player.id, ...player.getStateForNetwork() });
      expect(ws.sent.filter((message) => message.type === 'update').at(-1)?.data).toMatchObject({
        thrusting: true,
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
    const player = entityFactory.createLocalPlayer('Returning pilot', { x: 0, y: 0 }, 'scout');
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
    expect(player.ship.exploding).toBe(false);
    expect(player.ship.thrusting).toBe(true);
    expect(player.ship.angularVelocity).toBeGreaterThan(0);
    keyUp(new KeyboardEvent('keyup', { code: 'KeyW' }), player);
    keyUp(new KeyboardEvent('keyup', { code: 'KeyA' }), player);
    receive(4);
    expect(player.ship.thrusting).toBe(true);
    expect(player.ship.angularVelocity).toBe(0);
  });

  test('sampled snapshots correlate predicted and authoritative local state', async () => {
    const player = entityFactory.createLocalPlayer('Runtime pilot', { x: 900, y: 700 }, 'scout');
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
        playerMotion: { epoch: 3, mode: 'free', ack: 4 },
      },
    ];
    first.asteroids = [];
    first.loot = [];
    first.satellitePickups = [];
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
    const player = entityFactory.createLocalPlayer('Runtime pilot', { x: 900, y: 700 }, 'scout');
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
    const player = entityFactory.createLocalPlayer('Runtime pilot', { x: 500, y: 100 }, 'scout');
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
      playerMotion: { epoch: 1, mode: 'free', ack: 0 },
    });
    state.asteroids = [];
    state.loot = [];
    state.satellitePickups = [];
    state.collabTags = [];
    ws.receive('snapshot', new SnapshotEncoder(state).encode(1));
    expect(manager.getAllPlayers()).toEqual([player]);
    const { getSpiderField, setSpiderField } = await import(
      '../../../src/physics/terrain/spiderSession'
    );
    setSpiderField({
      nests: [{ id: '0,0', resourceId: 'ore', position: { x: 5000, y: 5000 } }],
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
    expect(initialJoinData['clientReleaseId']).toMatch(CLIENT_RELEASE_ID_PATTERN);
    expect(new URL(ws.url).searchParams.get('snapshotVersion')).toBe('1');
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
      expect.any(SyntaxError)
    );
    expect(ws.close).not.toHaveBeenCalled();
    expect(manager.isConnected()).toBe(true);
  });

  test('an unknown typed envelope reaches dispatch without retiring the socket', async () => {
    const debugLog = vi.spyOn(logger, 'debug').mockImplementation(() => undefined);
    const ws = await connect();

    ws.receiveRaw('{"type":"futureServerEvent","data":{"value":1}}');

    expect(debugLog).toHaveBeenCalledWith('NETWORK', 'Unhandled server message type', {
      type: 'futureServerEvent',
    });
    expect(ws.close).not.toHaveBeenCalled();
    expect(manager.isConnected()).toBe(true);
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
    expect(manager.isConnected()).toBe(false);
    expect(manager.getAllPlayers()).toEqual([]);
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
    firstPilot.name = 'Runtime pilot'; // Display names are not session identities.
    firstPilot.kitId = 'hauler';
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
    nextPilot.name = 'Renamed pilot';
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
    expect(manager.getPlayer('pilot-1')?.ship.harpoonTargetId).toBeNull();
    expect(manager.getPlayer('pilot-1')?.ship.harpoonLatchPos).toBeUndefined();
    expect(manager.getPlayer('pilot-1')?.ship.kitId).toBe('scout');
    expect(manager.getPlayer('pilot-1')?.name).toBe('Renamed pilot');
    expect(removed).toHaveLength(80);
    expect(LootField.getInstance().getAll()).toEqual([]);
    ws.receive('snapshot', new SnapshotEncoder(first).encode(20));
    expect(manager.getAllPlayers()).toHaveLength(10);
    expect(LootField.getInstance().getAll()).toEqual(first.loot);
  });

  test('pickup ownership, tag expiry and asteroid metadata reconcile in real managers', async () => {
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
    const pickups = SatellitePickupManager.getInstance();
    expect(pickups.getAll()).toHaveLength(6);
    expect(pickups.get('pickup-0')?.ownerId).toBe('pilot-0');
    expect(belt.get('asteroid-0')?.taggedUntil).toBe(5000);
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
    delete nextAsteroid.isCollabTarget;
    ws.receive('snapshot', new SnapshotEncoder(next).encode(2, { sequence: 1, state: first }));
    expect(pickups.get('pickup-0')?.ownerId).toBeNull();
    expect(pickups.get('pickup-0')?.health).toBe(25);
    expect(belt.get('asteroid-0')).toMatchObject({
      material: 'rubble',
      offsets: [0.7, 1.2, 0.8],
      vertices: 3,
      jaggedness: 0.9,
      isCollabTarget: false,
      taggedUntil: 0,
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
    const player = entityFactory.createLocalPlayer('Runtime pilot', { x: 500, y: 100 }, 'hauler');
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

  test('a stale snapshot does not clear a predicted Mineral Scan cooldown', async () => {
    const player = entityFactory.createLocalPlayer('Runtime pilot', { x: 500, y: 100 }, 'scout');
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
    player.ship.abilityCooldownFrames = SHIP_ABILITY.COOLDOWN_FRAMES.scout;
    const stale = captureSnapshot(zero);
    const staleEntity = stale.entities[0];
    assert.ok(staleEntity, 'stale snapshot entity');
    staleEntity.abilityCooldownFrames = 0;
    ws.receive('snapshot', new SnapshotEncoder(stale).encode(2));
    expect(player.ship.abilityCooldownFrames).toBe(SHIP_ABILITY.COOLDOWN_FRAMES.scout);
    const echoed = captureSnapshot(stale);
    const echoedEntity = echoed.entities[0];
    assert.ok(echoedEntity, 'echoed snapshot entity');
    echoedEntity.abilityCooldownFrames = SHIP_ABILITY.COOLDOWN_FRAMES.scout - 4;
    ws.receive('snapshot', new SnapshotEncoder(echoed).encode(3));
    expect(player.ship.abilityCooldownFrames).toBe(SHIP_ABILITY.COOLDOWN_FRAMES.scout - 4);
  });

  test('a probe miss snapshot keeps the Scout ability ready', async () => {
    const player = entityFactory.createLocalPlayer('Runtime pilot', { x: 500, y: 100 }, 'scout');
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
    publishHarpoonField([{ id: 'asteroid-1', position: { x: 1, y: 2 }, velocity: { x: 0, y: 0 } }]);
    Object.assign(player.ship, {
      harpoonTargetId: 'asteroid-1',
      harpoonLatchPos: { x: 1, y: 2 },
      abilityActiveFrames: 30,
      abilityCooldownFrames: 80,
    });
    manager.sendMessage({ type: 'useAbility', data: { abilityId: 'harpoon' } });
    const emptyBelt = captureSnapshot(zero);
    emptyBelt.asteroids = [];
    emptyBelt.collabTags = [];
    ws.receive('snapshot', new SnapshotEncoder(emptyBelt).encode(2));
    expect(player.ship.harpoonTargetId).toBe('asteroid-1');
    expect(player.ship.harpoonLatchPos).toEqual({ x: 1, y: 2 });
  });

  test('socket-flap Hauler visuals clear on an authoritative release', async () => {
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
    queuedPilot.health = 23;
    ws.receive('snapshot', new SnapshotEncoder(queued).encode(16, { sequence: 15, state }));
    expect(ws.close).not.toHaveBeenCalled();
    expect(manager.getPlayer('pilot-1')?.ship.health).toBe(23);
    acknowledge(ws);
    ws.receive('snapshot', new SnapshotEncoder(state).encode(1));
    const statePilot = state.entities[1];
    assert.ok(statePilot, 'state pilot entity');
    expect(manager.getPlayer('pilot-1')?.ship.health).toBe(statePilot.health);
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
