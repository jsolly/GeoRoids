import { strict as assert } from 'node:assert';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { normalizeFixtureAsteroids } from '../../../benchmarks/fixture-control';
import { observesPreparedFixture } from '../../../benchmarks/fixture-readiness';
import { MessageHandler } from '../../../server/communication/MessageHandler';
import { GameEngine } from '../../../server/core/GameEngine';
import { serverPerformanceMetrics } from '../../../server/performanceMetrics';
import { GameStateBroadcaster } from '../../../server/services/GameStateBroadcaster';
import { logger } from '../../../setup/serverLogger';
import {
  SNAPSHOT_BACKPRESSURE_BYTES,
  SNAPSHOT_KEYFRAME_INTERVAL,
  SnapshotDecoder,
  SnapshotEncoder,
} from '../../../shared/snapshotProtocol';
import type { ServerGameSnapshot } from '../../../shared-types';
import { decodeSnapshotMessage } from '../../support/decodeSnapshotMessage';
import { RecordingSocket } from '../../support/recordingSocket';

const RESUME_TOKEN_PATTERN = /^[a-f0-9]{64}$/u;

type SendCallback = (error?: Error) => void;
type SendOptions = {
  mask?: boolean;
  binary?: boolean;
  compress?: boolean;
  fin?: boolean;
};
type SendData = Parameters<RecordingSocket['send']>[0];

class DelayedRecordingSocket extends RecordingSocket {
  defer = false;
  fail = false;

  constructor(private readonly pending: Array<(error?: Error) => void>) {
    super();
  }

  override send(data: SendData, callback?: SendCallback): void;
  override send(data: SendData, options: SendOptions, callback?: SendCallback): void;
  override send(
    data: SendData,
    optionsOrCallback?: SendOptions | SendCallback,
    callback?: SendCallback
  ): void {
    if (this.fail) {
      throw new Error('closed during send');
    }
    if (typeof optionsOrCallback === 'object') {
      super.send(data, optionsOrCallback, callback);
      return;
    }
    const done = optionsOrCallback ?? callback;
    super.send(data);
    if (done) {
      if (this.defer) {
        this.pending.push(done);
      } else {
        done();
      }
    }
  }
}

function socket() {
  const pending: Array<(error?: Error) => void> = [];
  const fake = new DelayedRecordingSocket(pending);
  const close = vi.spyOn(fake, 'close');
  return { fake, close, ws: fake, messages: fake.inbox, pending };
}

interface SnapshotEnvelope {
  readonly raw: string;
  readonly data: unknown;
  readonly timestamp: number;
}

function snapshotEnvelopes(pilot: ReturnType<typeof socket>): SnapshotEnvelope[] {
  const result: SnapshotEnvelope[] = [];
  for (const raw of pilot.fake.sent) {
    const value: unknown = JSON.parse(raw);
    if (
      value === null ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      !('type' in value) ||
      value.type !== 'snapshot' ||
      !('data' in value) ||
      !('timestamp' in value) ||
      typeof value.timestamp !== 'number'
    ) {
      continue;
    }
    result.push({ raw, data: value.data, timestamp: value.timestamp });
  }
  return result;
}

interface SnapshotSummary {
  readonly sequence: number;
  readonly kind: 'keyframe' | 'delta';
  readonly baseline?: number;
}

function snapshotSummary(data: unknown): SnapshotSummary {
  if (
    data === null ||
    typeof data !== 'object' ||
    Array.isArray(data) ||
    !('sequence' in data) ||
    typeof data.sequence !== 'number' ||
    !('kind' in data)
  ) {
    throw new Error('Malformed snapshot frame in recording');
  }
  if (data.kind === 'keyframe') {
    return { sequence: data.sequence, kind: 'keyframe' };
  }
  if (data.kind === 'delta' && 'baseline' in data && typeof data.baseline === 'number') {
    return { sequence: data.sequence, kind: 'delta', baseline: data.baseline };
  }
  throw new Error('Malformed snapshot frame kind in recording');
}

function decodedSnapshots(pilot: ReturnType<typeof socket>) {
  const decoder = new SnapshotDecoder();
  const states: ServerGameSnapshot[] = [];
  for (const raw of pilot.fake.sent) {
    const result = decoder.readMessage(raw, { acceptSnapshots: true });
    if (result.kind === 'snapshot-rejected') {
      throw result.error;
    }
    if (result.kind === 'snapshot') {
      states.push(result.state);
    } else if (
      result.message &&
      typeof result.message === 'object' &&
      'type' in result.message &&
      result.message.type === 'joined'
    ) {
      decoder.reset();
    }
  }
  return states;
}

describe('current pilots share the production handler and broadcaster', () => {
  let engine: GameEngine;
  let broadcaster: GameStateBroadcaster;
  let handler: MessageHandler;
  beforeEach(() => {
    engine = new GameEngine(72);
    broadcaster = new GameStateBroadcaster(engine);
    handler = new MessageHandler(engine, broadcaster);
  });
  afterEach(() => {
    engine.stopGameLoop();
    broadcaster.stopPeriodicBroadcast();
  });
  const joinPilot = (
    messageHandler: MessageHandler,
    ws: WebSocket,
    id: string,
    resumeToken?: string
  ) =>
    messageHandler.handleMessage(
      {
        type: 'join',
        data: {
          id,
          name: id,
          position: { x: 100, y: 100 },
          snapshotVersion: 1,
          asteroidInteractions: 1,
          ...(resumeToken ? { resumeToken } : {}),
        },
      },
      ws
    );

  test('current offers receive a joined acknowledgment before snapshot-v1 frames', () => {
    const pilot = socket();
    joinPilot(handler, pilot.ws, 'pilot');
    broadcaster.broadcastGameState();
    const joined = pilot.messages.find((m) => m.type === 'joined');
    assert.ok(joined, 'joined message');
    expect(joined).toMatchObject({
      type: 'joined',
      data: {
        snapshotVersion: 1,
        asteroidInteractions: 1,
        resumeToken: expect.stringMatching(RESUME_TOKEN_PATTERN),
        serverReleaseId: expect.any(String),
        credentialReleaseId: expect.any(String),
        scoreReleaseId: expect.any(String),
      },
    });
    expect(pilot.messages[0]?.type).toBe('joined');
    const snapshot = decodedSnapshots(pilot)[0];
    assert.ok(snapshot, 'snapshot-v1 state');
    expect(snapshot).toMatchObject({
      entities: expect.any(Array),
      playerProjectiles: expect.any(Array),
    });
  });

  test('a sampled snapshot is logged only after its transport callback succeeds', () => {
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    const pilot = socket();
    pilot.fake.defer = true;
    joinPilot(handler, pilot.ws, 'sampled-pilot');
    expect(
      info.mock.calls.some(
        ([category, event]) => category === 'STATE' && event === 'snapshot_sent_to_transport'
      )
    ).toBe(false);

    pilot.pending.shift()?.();

    expect(info).toHaveBeenCalledWith(
      'STATE',
      'snapshot_sent_to_transport',
      expect.objectContaining({
        playerId: 'sampled-pilot',
        snapshotSequence: 1,
        snapshotKind: 'keyframe',
        authoritativeRow: expect.objectContaining({
          position: expect.objectContaining({ x: expect.any(Number), y: expect.any(Number) }),
        }),
      })
    );
  });

  test('late joins, exclusions, backpressure, rejoin and reconnect have independent baselines', () => {
    // Hold snapshot time steady while comparing independently reconstructed world baselines.
    vi.spyOn(engine, 'getServerTime').mockReturnValue(engine.getServerTime());
    const expectedWorld = (id = 'a') => {
      const viewer = engine.getPlayer(id);
      assert(viewer);
      const state = engine.getGameState();
      const nearby = <T extends { position: { x: number; y: number } }>(rows: T[]) =>
        rows.filter(
          (row) =>
            Math.abs(row.position.x - viewer.position.x) <= 2800 &&
            Math.abs(row.position.y - viewer.position.y) <= 2800
        );
      const asteroids = nearby(state.asteroids);
      return new SnapshotEncoder({
        ...state,
        asteroids,
        loot: nearby(state.loot),
        satellitePickups: nearby(state.satellitePickups),
        playerProjectiles: nearby(engine.getPlayerProjectiles()),
        collabTags: engine
          .getActiveCollabTags()
          .filter((tag) => asteroids.some((rock) => rock.id === tag.asteroidId))
          .map((tag) => ({ id: tag.asteroidId, ...tag })),
      }).state;
    };
    const a = socket();
    joinPilot(handler, a.ws, 'a');
    const joinedA = a.messages.find((message) => message.type === 'joined');
    assert.ok(joinedA?.data && typeof joinedA.data === 'object' && !Array.isArray(joinedA.data));
    const resumeTokenA = (joinedA.data as Record<string, unknown>)['resumeToken'];
    assert.equal(typeof resumeTokenA, 'string');
    const b = socket();
    joinPilot(handler, b.ws, 'b');
    const pilotBSnapshot = b.messages.find((m) => m.type === 'snapshot');
    assert.ok(pilotBSnapshot, 'pilot b snapshot');
    expect(pilotBSnapshot).toMatchObject({ data: { kind: 'keyframe' } });
    const reconstruct = (pilot: ReturnType<typeof socket>) => {
      return decodedSnapshots(pilot).at(-1);
    };
    expect(reconstruct(a)).toEqual(expectedWorld());
    expect(reconstruct(b)).toEqual(expectedWorld('b'));
    const count = a.messages.length;
    broadcaster.broadcastGameState('a');
    expect(a.messages).toHaveLength(count);
    a.fake.bufferedAmount = SNAPSHOT_BACKPRESSURE_BYTES + 1;
    broadcaster.broadcastGameState();
    expect(a.messages).toHaveLength(count);
    a.fake.bufferedAmount = 0;
    const playerB = engine.getPlayer('b');
    assert.ok(playerB, 'player b');
    playerB.position.x = 720;
    broadcaster.broadcastGameState();
    const pilotAKeyframe = a.messages.at(-1);
    assert.ok(pilotAKeyframe, 'pilot a keyframe');
    expect(pilotAKeyframe).toMatchObject({ data: { kind: 'keyframe' } });
    expect(reconstruct(a)).toEqual(expectedWorld());
    expect(reconstruct(b)).toEqual(expectedWorld('b'));
    joinPilot(handler, a.ws, 'a', resumeTokenA as string);
    const rejoinedKeyframe = a.messages.at(-1);
    assert.ok(rejoinedKeyframe, 'rejoined pilot a keyframe');
    expect(rejoinedKeyframe.data).toMatchObject({
      sequence: 1,
      kind: 'keyframe',
    });
    engine.removePlayer('a');
    const reconnected = socket();
    joinPilot(handler, reconnected.ws, 'a', resumeTokenA as string);
    const reconnectedKeyframe = reconnected.messages.at(-1);
    assert.ok(reconnectedKeyframe, 'reconnected keyframe');
    expect(reconnectedKeyframe.data).toMatchObject({
      sequence: 1,
      kind: 'keyframe',
    });
    expect(reconstruct(reconnected)).toEqual(expectedWorld());
  });

  test('staggered recipients retain accepted baselines while peers advance independently', () => {
    const a = socket();
    const b = socket();
    joinPilot(handler, a.ws, 'a');
    joinPilot(handler, b.ws, 'b');

    a.fake.defer = true;
    broadcaster.broadcastGameState();
    const playerB = engine.getPlayer('b');
    assert.ok(playerB, 'pilot b');
    playerB.position.x = 720;
    broadcaster.broadcastGameState();
    const pending = a.pending.shift();
    assert.ok(pending, 'deferred snapshot callback');
    pending();
    a.fake.defer = false;
    broadcaster.broadcastGameState();

    const aSnapshots = snapshotEnvelopes(a);
    const bSnapshots = snapshotEnvelopes(b);
    expect(aSnapshots.map(({ data }) => snapshotSummary(data))).toEqual([
      { sequence: 1, kind: 'keyframe' },
      { sequence: 2, kind: 'delta', baseline: 1 },
      { sequence: 3, kind: 'delta', baseline: 2 },
      { sequence: 4, kind: 'delta', baseline: 3 },
    ]);
    expect(bSnapshots.map(({ data }) => snapshotSummary(data))).toEqual([
      { sequence: 1, kind: 'keyframe' },
      { sequence: 2, kind: 'delta', baseline: 1 },
      { sequence: 3, kind: 'delta', baseline: 2 },
      { sequence: 4, kind: 'delta', baseline: 3 },
    ]);
    for (const envelope of [...aSnapshots, ...bSnapshots]) {
      expect(envelope.raw).toBe(
        JSON.stringify({
          type: 'snapshot',
          data: envelope.data,
          timestamp: envelope.timestamp,
        })
      );
    }

    const aDecoder = new SnapshotDecoder();
    const bDecoder = new SnapshotDecoder();
    const aWorld = aSnapshots.map(({ raw }) => decodeSnapshotMessage(aDecoder, raw)).at(-1);
    const bWorld = bSnapshots.map(({ raw }) => decodeSnapshotMessage(bDecoder, raw)).at(-1);
    expect(aWorld?.entities).toEqual(bWorld?.entities);
    expect(aWorld?.mapAssets).toEqual(bWorld?.mapAssets);
    expect(aWorld).toMatchObject({ entities: expect.any(Array) });
  });

  test('a laser core stays collectible while current pilots decode keyframes and deltas', () => {
    const recovery = socket();
    const peer = socket();
    joinPilot(handler, recovery.ws, 'recovery');
    joinPilot(handler, peer.ws, 'peer');
    engine.addAsteroid({
      id: 'core-rock',
      position: { x: 500, y: 500 },
      velocity: { x: 0, y: 0 },
      size: 32,
      vertices: 4,
      offsets: [1, 1, 1, 1],
      jaggedness: 0,
      rotation: 0,
      angularVelocity: 0,
      health: 75,
      maxHealth: 75,
      material: 'metal',
      phenomenon: { kind: 'reflective', clusterId: 'test', energy: 0, maxEnergy: 6 },
    });
    for (let hit = 0; hit < 3; hit++) {
      engine.handleAsteroidHit('core-rock', 'peer');
    }
    const core = engine.getLoot().find((loot) => loot.kind === 'laserCore');
    assert.ok(core, 'laser core loot');
    broadcaster.broadcastGameState();
    broadcaster.requestSnapshotKeyframe(recovery.ws);
    broadcaster.broadcastGameState();
    const decodeAll = (pilot: ReturnType<typeof socket>) => {
      return decodedSnapshots(pilot);
    };
    expect(
      decodeAll(recovery)
        .at(-1)
        ?.loot.find((loot) => loot.id === core.id)?.kind
    ).toBe('laserCore');
    expect(
      decodeAll(peer)
        .at(-1)
        ?.loot.find((loot) => loot.id === core.id)?.kind
    ).toBe('laserCore');
    const collector = engine.getPlayer('recovery');
    assert.ok(collector, 'recovery player');
    collector.position = { ...core.position };
    const score = collector.score;
    engine.collectLoot();
    expect(collector.laserUpgrade?.charges).toBe(6);
    expect(collector.score).toBeGreaterThanOrEqual(score + 150);
    const collectedScore = collector.score;
    engine.collectLoot();
    expect(collector.score).toBe(collectedScore);
    broadcaster.broadcastGameState();
    expect(
      decodeAll(recovery)
        .at(-1)
        ?.loot.some((loot) => loot.id === core.id)
    ).toBe(false);
    expect(
      decodeAll(peer)
        .at(-1)
        ?.loot.some((loot) => loot.id === core.id)
    ).toBe(false);
  });

  test('pending and failed sends do not advance baseline; periodic/resync keyframes heal state', () => {
    const a = socket();
    joinPilot(handler, a.ws, 'a');
    a.fake.defer = true;
    broadcaster.broadcastGameState();
    broadcaster.broadcastGameState();
    const failedSend = a.pending.shift();
    assert.ok(failedSend, 'deferred snapshot callback');
    failedSend(new Error('write failed'));
    a.fake.defer = false;
    broadcaster.broadcastGameState();
    const recoveryKeyframe = a.messages.at(-1);
    assert.ok(recoveryKeyframe, 'recovery keyframe');
    expect(recoveryKeyframe.data).toMatchObject({
      sequence: 2,
      kind: 'keyframe',
    });
    const beforePeriodic = snapshotEnvelopes(a).length;
    for (let i = 0; i <= SNAPSHOT_KEYFRAME_INTERVAL; i++) {
      broadcaster.broadcastGameState();
    }
    const periodic = snapshotEnvelopes(a)
      .slice(beforePeriodic)
      .map(({ data }) => snapshotSummary(data));
    expect(periodic).toHaveLength(SNAPSHOT_KEYFRAME_INTERVAL + 1);
    expect(periodic.slice(0, -1).every(({ kind }) => kind === 'delta')).toBe(true);
    expect(periodic.at(-1)).toEqual({
      sequence: SNAPSHOT_KEYFRAME_INTERVAL + 3,
      kind: 'keyframe',
    });
    handler.handleMessage({ type: 'snapshotResync' }, a.ws);
    broadcaster.broadcastGameState();
    const resyncKeyframe = a.messages.at(-1);
    assert.ok(resyncKeyframe, 'resync keyframe');
    expect(resyncKeyframe).toMatchObject({ data: { kind: 'keyframe' } });
    a.fake.fail = true;
    broadcaster.broadcastGameState();
    expect(a.fake.close).toHaveBeenCalledWith(1011, 'Snapshot encoding failed');
  });

  test('a callback send records one terminal outbound outcome', () => {
    const pilot = socket();
    joinPilot(handler, pilot.ws, 'callback-pilot');
    pilot.fake.clear();
    pilot.fake.defer = true;
    const enabled = vi.spyOn(serverPerformanceMetrics, 'enabled', 'get').mockReturnValue(true);
    const outbound = vi
      .spyOn(serverPerformanceMetrics, 'recordOutbound')
      .mockImplementation(() => undefined);

    broadcaster.broadcastGameState();
    const beforeCompletion = outbound.mock.calls.length;
    expect(pilot.pending).toHaveLength(1);

    pilot.pending.shift()?.(new Error('write failed'));

    const completionCalls = outbound.mock.calls.slice(beforeCompletion);
    expect(completionCalls).toHaveLength(1);
    expect(completionCalls[0]?.[0]).toMatchObject({
      kind: 'snapshot',
      outcome: 'failed',
    });
    enabled.mockRestore();
  });

  test('current snapshots skip a pressured socket and recover on the next keyframe', () => {
    const pilot = socket();
    joinPilot(handler, pilot.ws, 'pressured-snapshot');
    pilot.fake.clear();
    pilot.fake.bufferedAmount = SNAPSHOT_BACKPRESSURE_BYTES + 1;

    broadcaster.broadcastGameState();
    expect(pilot.messages).toHaveLength(0);

    pilot.fake.bufferedAmount = 0;
    broadcaster.broadcastGameState();
    expect(pilot.messages.at(-1)).toMatchObject({
      type: 'snapshot',
      data: { kind: 'keyframe' },
    });
  });

  test('pressured event recipients reconnect for state recovery instead of growing queues', () => {
    const pressured = socket();
    const peer = socket();
    joinPilot(handler, pressured.ws, 'pressured');
    joinPilot(handler, peer.ws, 'peer');
    pressured.fake.clear();
    peer.fake.clear();
    pressured.fake.bufferedAmount = SNAPSHOT_BACKPRESSURE_BYTES + 1;

    broadcaster.broadcastChatMessage('peer', 'peer', 'hello');

    expect(pressured.close).toHaveBeenCalledWith(
      1013,
      'Backpressure; reconnect for state recovery'
    );
    expect(pressured.messages.some((message) => message.type === 'chat')).toBe(false);
    const pressuredPlayer = engine.getPlayer('pressured');
    assert.ok(pressuredPlayer, 'pressured pilot retained for recovery');
    expect(pressuredPlayer.ws).toBeUndefined();
    expect(peer.messages.some((message) => message.type === 'playerLeft')).toBe(false);
  });

  test.each([
    {
      cause: 'outbound pressure',
      code: 1013,
      reason: 'Backpressure; reconnect for state recovery',
    },
    {
      cause: 'a failed event write',
      code: 1011,
      reason: 'Transport failure; reconnect for state recovery',
    },
  ])('current recipients retain their pilot and resume after $cause', ({ code, reason }) => {
    const pressured = socket();
    const peer = socket();
    joinPilot(handler, pressured.ws, 'current-pressured');
    const joined = pressured.messages.find((message) => message.type === 'joined');
    assert.ok(joined?.data && typeof joined.data === 'object' && !Array.isArray(joined.data));
    const resumeToken = (joined.data as Record<string, unknown>)['resumeToken'];
    assert.equal(typeof resumeToken, 'string');

    joinPilot(handler, peer.ws, 'peer');
    pressured.fake.clear();
    peer.fake.clear();
    if (code === 1013) {
      pressured.fake.bufferedAmount = SNAPSHOT_BACKPRESSURE_BYTES + 1;
    } else {
      pressured.fake.fail = true;
    }

    broadcaster.broadcastChatMessage('peer', 'peer', 'hello');

    expect(engine.getPlayer('current-pressured')).toBeDefined();
    expect(engine.getPlayer('current-pressured')?.ws).toBeUndefined();
    expect(peer.messages.some((message) => message.type === 'playerLeft')).toBe(false);
    expect(pressured.close).toHaveBeenCalledWith(code, reason);

    const replacement = socket();
    handler.handleMessage(
      {
        type: 'join',
        data: {
          id: 'untrusted-replacement-id',
          name: 'untrusted-replacement',
          position: { x: 800, y: 800 },
          snapshotVersion: 1,
          asteroidInteractions: 1,
          resumeToken,
        },
      },
      replacement.ws
    );
    expect(replacement.messages.find((message) => message.type === 'joined')).toMatchObject({
      data: { id: 'current-pressured', resumeToken },
    });
    expect(engine.getPlayer('current-pressured')?.ws).toBe(replacement.ws);
  });

  test('projected outbound pressure bounds snapshot, event, and control classes', () => {
    const snapshot = socket();
    const event = socket();
    const control = socket();
    joinPilot(handler, snapshot.ws, 'projected-snapshot');
    joinPilot(handler, event.ws, 'projected-event');
    joinPilot(handler, control.ws, 'projected-control');
    snapshot.fake.clear();
    event.fake.clear();
    control.fake.clear();

    snapshot.fake.bufferedAmount = SNAPSHOT_BACKPRESSURE_BYTES - 1;
    broadcaster.sendToWebSocket(snapshot.ws, { type: 'snapshot', data: 'too-large-for-queue' });
    expect(snapshot.fake.sent).toHaveLength(0);
    expect(snapshot.close).not.toHaveBeenCalled();

    event.fake.bufferedAmount = SNAPSHOT_BACKPRESSURE_BYTES - 1;
    broadcaster.sendToWebSocket(event.ws, { type: 'chat', data: { message: 'hello' } });
    expect(event.close).toHaveBeenCalledWith(1013, 'Backpressure; reconnect for state recovery');
    const pressuredEventPlayer = engine.getPlayer('projected-event');
    assert.ok(pressuredEventPlayer, 'event pilot retained for recovery');
    expect(pressuredEventPlayer.ws).toBeUndefined();

    control.fake.bufferedAmount = SNAPSHOT_BACKPRESSURE_BYTES - 1;
    broadcaster.sendToWebSocket(control.ws, { type: 'error', data: 'control' });
    expect(control.close).toHaveBeenCalledWith(1013, 'Backpressure; reconnect for state recovery');
    const pressuredControlPlayer = engine.getPlayer('projected-control');
    assert.ok(pressuredControlPlayer, 'control pilot retained for recovery');
    expect(pressuredControlPlayer.ws).toBeUndefined();
  });

  test('an oversized snapshot closes explicitly instead of retrying forever', () => {
    const pilot = socket();
    joinPilot(handler, pilot.ws, 'oversized-snapshot');
    pilot.fake.clear();

    broadcaster.sendToWebSocket(pilot.ws, {
      type: 'snapshot',
      data: { kind: 'keyframe', state: 'x'.repeat(SNAPSHOT_BACKPRESSURE_BYTES) },
    });

    expect(pilot.close).toHaveBeenCalledWith(1013, 'Backpressure; reconnect for state recovery');
    const oversizedPlayer = engine.getPlayer('oversized-snapshot');
    assert.ok(oversizedPlayer, 'oversized pilot retained for recovery');
    expect(oversizedPlayer.ws).toBeUndefined();
  });

  test('serialization and socket-close failures stay contained to recipients', () => {
    const first = socket();
    const second = socket();
    joinPilot(handler, first.ws, 'first');
    joinPilot(handler, second.ws, 'second');
    const broken = engine.getGameState();
    Object.assign(broken, { badField: broken });
    vi.spyOn(engine, 'getGameState').mockReturnValue(broken);
    first.close.mockImplementation(() => {
      throw new Error('close failure');
    });
    expect(() => broadcaster.broadcastGameState()).not.toThrow();
    expect(first.fake.close).toHaveBeenCalled();
    expect(second.fake.close).toHaveBeenCalledWith(1011, 'Snapshot encoding failed');
  });
  test('heartbeat replies echo probe identity while legacy pings remain bare and invalid probes are rejected', () => {
    const pilot = socket();
    handler.handleMessage({ type: 'ping', probeId: 7 }, pilot.ws);
    expect(JSON.parse(pilot.fake.sent.at(-1) ?? 'null')).toEqual({
      type: 'pong',
      timestamp: expect.any(Number),
      probeId: 7,
    });
    handler.handleMessage({ type: 'ping' }, pilot.ws);
    expect(JSON.parse(pilot.fake.sent.at(-1) ?? 'null')).toEqual({
      type: 'pong',
      timestamp: expect.any(Number),
    });
    handler.handleMessage({ type: 'ping', probeId: -1 }, pilot.ws);
    expect(pilot.messages.filter((message) => message.type === 'pong')).toHaveLength(2);
  });

  test('fixture preparation preserves a pilot session while replacing the ambient world', () => {
    const pilot = socket();
    joinPilot(handler, pilot.ws, 'pilot');
    const actor = engine.getPlayer('pilot');
    assert.ok(actor);
    const oldEpoch = actor.playerMotion?.epoch;
    assert.ok(oldEpoch);
    engine.prepareDiagnosticWorld('combat');
    expect(engine.getPlayer('pilot')).toBe(actor);
    expect(actor.ws).toBe(pilot.ws);
    expect(
      engine.playerMotion.placeActorForTesting('pilot', { x: 100, y: 0 }, engine.getServerTime())
    ).toBe(true);
    expect(actor.playerMotion?.epoch).toBe(oldEpoch + 1);
    expect(engine.getDiagnostics()).toMatchObject({
      players: 1,
      asteroids: 80,
      satellitePickups: 6,
    });
    expect(engine.getPlayerProjectiles()).toHaveLength(0);
    const firstRocks = normalizeFixtureAsteroids(engine.getAllAsteroids());
    engine.prepareDiagnosticWorld('combat');
    expect(normalizeFixtureAsteroids(engine.getAllAsteroids())).toEqual(firstRocks);
    expect(pilot.close).not.toHaveBeenCalled();
  });

  test.each([
    { pendingKind: 'keyframe' as const, outcome: 'success' as const },
    { pendingKind: 'keyframe' as const, outcome: 'failure' as const },
    { pendingKind: 'delta' as const, outcome: 'success' as const },
    { pendingKind: 'delta' as const, outcome: 'failure' as const },
  ])(
    'fixture readiness rejects a pending old $pendingKind after callback $outcome',
    ({ pendingKind, outcome }) => {
      const pilot = socket();
      joinPilot(handler, pilot.ws, 'pilot');
      const decoder = new SnapshotDecoder();
      let lastKeyframeSequence = 1;
      let state = decodeSnapshotMessage(decoder, snapshotEnvelopes(pilot)[0]?.raw ?? '');
      const actor = engine.getPlayer('pilot');
      assert.ok(actor?.playerMotion, 'authoritative pilot motion');
      const oldEpoch = actor.playerMotion.epoch;
      if (pendingKind === 'keyframe') {
        broadcaster.requestSnapshotKeyframe(pilot.ws);
      }
      pilot.fake.defer = true;
      broadcaster.broadcastGameState();
      const oldFrame = snapshotEnvelopes(pilot).at(-1);
      assert.ok(oldFrame, 'pending old frame');
      expect(snapshotSummary(oldFrame.data).kind).toBe(pendingKind);

      expect(
        engine.playerMotion.placeActorForTesting(
          'pilot',
          { x: 220, y: -140 },
          engine.getServerTime()
        )
      ).toBe(true);
      const motionEpoch = actor.playerMotion?.epoch;
      assert.ok(motionEpoch, 'prepared authoritative motion epoch');
      expect(motionEpoch).toBe(oldEpoch + 1);
      const gameTime = engine.getGameState().gameTime;
      const sequence = broadcaster.requestSnapshotKeyframe(pilot.ws);
      assert.ok(sequence, 'keyframe sequence lower bound');
      expect(sequence).toBe(2);
      const requirement = { sequence, gameTime, motionEpoch };

      const complete = pilot.pending.shift();
      assert.ok(complete, 'pending snapshot completion');
      if (outcome === 'success') {
        complete();
        const result = decoder.readMessage(oldFrame.raw, { acceptSnapshots: true });
        assert.equal(result.kind, 'snapshot');
        state = result.state;
        if (result.metadata.kind === 'keyframe') {
          lastKeyframeSequence = result.metadata.sequence;
        }
      } else {
        complete(new Error('write failed'));
      }
      const oldPlayer = state.entities.find((entity) => entity.id === 'pilot');
      expect(
        observesPreparedFixture(requirement, {
          lastKeyframeSequence,
          lastSnapshotGameTime: state.gameTime,
          motionEpoch: oldPlayer?.playerMotion?.epoch ?? null,
        })
      ).toBe(false);

      pilot.fake.defer = false;
      broadcaster.broadcastGameState();
      const recoveryFrame = snapshotEnvelopes(pilot).at(-1);
      assert.ok(recoveryFrame, 'requested recovery keyframe');
      const recovery = decoder.readMessage(recoveryFrame.raw, { acceptSnapshots: true });
      assert.equal(recovery.kind, 'snapshot');
      expect(recovery.metadata).toMatchObject({
        kind: 'keyframe',
        sequence: outcome === 'success' ? 3 : 2,
      });
      const recoveredPlayer = recovery.state.entities.find((entity) => entity.id === 'pilot');
      expect(recovery.state.gameTime).toBe(gameTime);
      expect(
        observesPreparedFixture(requirement, {
          lastKeyframeSequence: recovery.metadata.sequence,
          lastSnapshotGameTime: recovery.state.gameTime,
          motionEpoch: recoveredPlayer?.playerMotion?.epoch ?? null,
        })
      ).toBe(true);
    }
  );

  test.each(['success', 'failure'] as const)(
    'a stale callback %s cannot advance a fresh registration',
    (outcome) => {
      const pilot = socket();
      joinPilot(handler, pilot.ws, 'pilot');
      const oldActor = engine.getPlayer('pilot');
      assert.ok(oldActor, 'old actor');
      for (let epoch = 0; epoch < 4; epoch++) {
        expect(
          engine.playerMotion.placeActorForTesting(
            'pilot',
            { x: 100 + epoch, y: 100 },
            engine.getServerTime()
          )
        ).toBe(true);
      }
      broadcaster.broadcastGameState();
      broadcaster.broadcastGameState();
      broadcaster.requestSnapshotKeyframe(pilot.ws);
      pilot.fake.defer = true;
      broadcaster.broadcastGameState();
      const oldFrames = snapshotEnvelopes(pilot);
      const oldFrame = oldFrames.at(-1);
      const staleCompletion = pilot.pending.shift();
      assert.ok(oldFrame && staleCompletion, 'old session pending keyframe');
      const oldDecoder = new SnapshotDecoder();
      let staleState = decodeSnapshotMessage(oldDecoder, oldFrames[0]?.raw ?? '');
      for (const frame of oldFrames.slice(1)) {
        staleState = decodeSnapshotMessage(oldDecoder, frame.raw);
      }
      const staleMetadata = snapshotSummary(oldFrame.data);

      const joined = pilot.messages.find((message) => message.type === 'joined');
      const joinedData = joined?.data;
      assert(
        joinedData &&
          typeof joinedData === 'object' &&
          'resumeToken' in joinedData &&
          typeof joinedData.resumeToken === 'string'
      );
      handler.handleMessage({ type: 'leave', data: {} }, pilot.ws);
      pilot.fake.defer = false;
      joinPilot(handler, pilot.ws, 'pilot', joinedData.resumeToken);
      const freshActor = engine.getPlayer('pilot');
      assert.ok(freshActor?.playerMotion, 'fresh actor registration');
      expect(freshActor.playerMotion.epoch).toBe(1);
      expect(
        engine.playerMotion.placeActorForTesting(
          'pilot',
          { x: -240, y: 80 },
          engine.getServerTime()
        )
      ).toBe(true);
      const freshEpoch = freshActor.playerMotion?.epoch;
      assert.ok(freshEpoch, 'fresh prepared epoch');
      const sequence = broadcaster.requestSnapshotKeyframe(pilot.ws);
      assert.ok(sequence, 'fresh keyframe lower bound');
      broadcaster.broadcastGameState();
      const freshFrames = snapshotEnvelopes(pilot).slice(oldFrames.length);
      const freshDecoder = new SnapshotDecoder();
      let freshState = decodeSnapshotMessage(freshDecoder, freshFrames[0]?.raw ?? '');
      for (const frame of freshFrames.slice(1)) {
        freshState = decodeSnapshotMessage(freshDecoder, frame.raw);
      }
      const requirement = {
        sequence,
        gameTime: freshState.gameTime,
        motionEpoch: freshEpoch,
      };
      const stalePlayer = staleState.entities.find((entity) => entity.id === 'pilot');
      expect(staleMetadata.kind).toBe('keyframe');
      expect(staleMetadata.sequence).toBeGreaterThanOrEqual(sequence);
      expect(stalePlayer?.playerMotion?.epoch).toBeGreaterThan(freshEpoch);
      expect(
        observesPreparedFixture(requirement, {
          lastKeyframeSequence: staleMetadata.sequence,
          lastSnapshotGameTime: staleState.gameTime,
          motionEpoch: stalePlayer?.playerMotion?.epoch ?? null,
        })
      ).toBe(true);

      staleCompletion(outcome === 'failure' ? new Error('old write failed') : undefined);
      broadcaster.broadcastGameState();
      const current = snapshotEnvelopes(pilot).at(-1);
      assert.ok(current, 'current session frame');
      expect(snapshotSummary(current.data)).toMatchObject({ sequence: 3, kind: 'delta' });
      const freshPlayer = freshState.entities.find((entity) => entity.id === 'pilot');
      expect(
        observesPreparedFixture(requirement, {
          lastKeyframeSequence: 2,
          lastSnapshotGameTime: freshState.gameTime,
          motionEpoch: freshPlayer?.playerMotion?.epoch ?? null,
        })
      ).toBe(true);
    }
  );

  test('a resumed motion session keeps its epoch monotonic', () => {
    const original = socket();
    joinPilot(handler, original.ws, 'pilot');
    const joined = original.messages.find((message) => message.type === 'joined');
    assert.ok(joined?.data && typeof joined.data === 'object' && !Array.isArray(joined.data));
    const resumeToken = (joined.data as Record<string, unknown>)['resumeToken'];
    assert(typeof resumeToken === 'string', 'resume token');
    const actor = engine.getPlayer('pilot');
    assert.ok(actor?.playerMotion, 'registered actor motion');
    expect(
      engine.playerMotion.placeActorForTesting('pilot', { x: 320, y: -40 }, engine.getServerTime())
    ).toBe(true);
    const preparedEpoch = actor.playerMotion?.epoch;
    assert.ok(preparedEpoch, 'prepared epoch');

    const replacement = socket();
    joinPilot(handler, replacement.ws, 'ignored-id', resumeToken);
    expect(engine.getPlayer('pilot')).toBe(actor);
    expect(engine.getPlayer('pilot')?.playerMotion?.epoch).toBe(preparedEpoch);
  });

  test('fixture readiness accepts an immediate requested keyframe lower bound', () => {
    const pilot = socket();
    joinPilot(handler, pilot.ws, 'pilot');
    const sequence = broadcaster.requestSnapshotKeyframe(pilot.ws);
    expect(sequence).toBe(2);
    broadcaster.broadcastGameState();
    const frame = snapshotEnvelopes(pilot).at(-1);
    assert.ok(frame, 'requested keyframe');
    expect(snapshotSummary(frame.data)).toEqual({ kind: 'keyframe', sequence: 2 });
  });

  test.each([{ outcome: 'success' }, { outcome: 'failure' }])(
    'a stale $outcome callback cannot mutate a same-socket rejoin',
    ({ outcome }) => {
      const pilot = socket();
      joinPilot(handler, pilot.ws, 'pilot');
      pilot.fake.defer = true;
      broadcaster.broadcastGameState();
      const staleCallback = pilot.pending.shift();
      assert.ok(staleCallback, 'old-session callback');

      pilot.fake.defer = false;
      broadcaster.negotiateSnapshot(pilot.ws);
      broadcaster.sendToWebSocket(pilot.ws, {
        type: 'joined',
        data: { snapshotVersion: 1 },
        timestamp: Date.now(),
      });
      broadcaster.broadcastGameState();
      staleCallback(outcome === 'failure' ? new Error('stale callback failure') : undefined);
      const actor = engine.getPlayer('pilot');
      assert.ok(actor, 'rejoined pilot');
      actor.position.x += 1;
      broadcaster.broadcastGameState();

      expect(
        snapshotEnvelopes(pilot)
          .slice(-2)
          .map(({ data }) => snapshotSummary(data))
      ).toEqual([
        { sequence: 1, kind: 'keyframe' },
        { sequence: 2, kind: 'delta', baseline: 1 },
      ]);
      expect(
        decodedSnapshots(pilot)
          .at(-1)
          ?.entities.find(({ id }) => id === 'pilot')?.position.x
      ).toBe(actor.position.x);
    }
  );
});
