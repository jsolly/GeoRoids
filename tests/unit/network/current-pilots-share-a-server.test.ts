import { strict as assert } from 'node:assert';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { normalizeFixtureAsteroids } from '../../../benchmarks/fixture-control';
import { MessageHandler } from '../../../server/communication/MessageHandler';
import { GameEngine } from '../../../server/core/GameEngine';
import { serverPerformanceMetrics } from '../../../server/performanceMetrics';
import { GameStateBroadcaster } from '../../../server/services/GameStateBroadcaster';
import { logger } from '../../../setup/serverLogger';
import {
  SNAPSHOT_BACKPRESSURE_BYTES,
  SNAPSHOT_KEYFRAME_INTERVAL,
  SnapshotDecoder,
} from '../../../shared/snapshotProtocol';
import { RecordingSocket } from '../../support/recordingSocket';

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
  const join = (handler: MessageHandler, ws: WebSocket, id: string, resumeToken?: string) =>
    handler.handleMessage(
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
    join(handler, pilot.ws, 'pilot');
    broadcaster.broadcastGameState();
    const joined = pilot.messages.find((m) => m.type === 'joined');
    assert.ok(joined, 'joined message');
    expect(joined).toMatchObject({
      type: 'joined',
      data: {
        snapshotVersion: 1,
        asteroidInteractions: 1,
        resumeToken: expect.stringMatching(/^[a-f0-9]{64}$/),
        serverReleaseId: expect.any(String),
      },
    });
    expect(pilot.messages[0]?.type).toBe('joined');
    const decoder = new SnapshotDecoder();
    const snapshot = pilot.messages.find((m) => m.type === 'snapshot');
    assert.ok(snapshot, 'snapshot-v1 frame');
    expect(decoder.decode(snapshot.data)).toMatchObject({
      entities: expect.any(Array),
      playerProjectiles: expect.any(Array),
    });
  });

  test('a sampled snapshot is logged only after its transport callback succeeds', () => {
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    const pilot = socket();
    pilot.fake.defer = true;
    join(handler, pilot.ws, 'sampled-pilot');
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
    const a = socket();
    join(handler, a.ws, 'a');
    const joinedA = a.messages.find((message) => message.type === 'joined');
    assert.ok(joinedA?.data && typeof joinedA.data === 'object' && !Array.isArray(joinedA.data));
    const resumeTokenA = (joinedA.data as Record<string, unknown>)['resumeToken'];
    assert.equal(typeof resumeTokenA, 'string');
    const b = socket();
    join(handler, b.ws, 'b');
    const pilotBSnapshot = b.messages.find((m) => m.type === 'snapshot');
    assert.ok(pilotBSnapshot, 'pilot b snapshot');
    expect(pilotBSnapshot).toMatchObject({ data: { kind: 'keyframe' } });
    const reconstruct = (pilot: ReturnType<typeof socket>) => {
      const decoder = new SnapshotDecoder();
      return pilot.messages
        .filter((message) => message.type === 'snapshot')
        .map((message) => decoder.decode(message.data))
        .at(-1);
    };
    expect(reconstruct(a)).toMatchObject(JSON.parse(JSON.stringify(engine.getGameState())));
    expect(reconstruct(b)).toEqual(reconstruct(a));
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
    expect(reconstruct(a)).toMatchObject(JSON.parse(JSON.stringify(engine.getGameState())));
    expect(reconstruct(b)).toEqual(reconstruct(a));
    join(handler, a.ws, 'a', resumeTokenA as string);
    const rejoinedKeyframe = a.messages.at(-1);
    assert.ok(rejoinedKeyframe, 'rejoined pilot a keyframe');
    expect(rejoinedKeyframe.data).toMatchObject({
      sequence: 1,
      kind: 'keyframe',
    });
    engine.removePlayer('a');
    const reconnected = socket();
    join(handler, reconnected.ws, 'a');
    const reconnectedKeyframe = reconnected.messages.at(-1);
    assert.ok(reconnectedKeyframe, 'reconnected keyframe');
    expect(reconnectedKeyframe.data).toMatchObject({
      sequence: 1,
      kind: 'keyframe',
    });
    expect(reconstruct(reconnected)).toMatchObject(
      JSON.parse(JSON.stringify(engine.getGameState()))
    );
  });

  test('a laser core stays collectible while current pilots decode keyframes and deltas', () => {
    const recovery = socket();
    const peer = socket();
    join(handler, recovery.ws, 'recovery');
    join(handler, peer.ws, 'peer');
    engine.addAsteroid({
      id: 'core-rock',
      position: { x: 5000, y: 5000 },
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
      const decoder = new SnapshotDecoder();
      return pilot.messages
        .filter((message) => message.type === 'snapshot')
        .map((message) => decoder.decode(message.data));
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
    join(handler, a.ws, 'a');
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
    for (let i = 0; i <= SNAPSHOT_KEYFRAME_INTERVAL; i++) {
      broadcaster.broadcastGameState();
    }
    expect(a.messages.slice(-2)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ data: expect.objectContaining({ kind: 'keyframe' }) }),
      ])
    );
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
    join(handler, pilot.ws, 'callback-pilot');
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
    join(handler, pilot.ws, 'pressured-snapshot');
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
    join(handler, pressured.ws, 'pressured');
    join(handler, peer.ws, 'peer');
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
    join(handler, pressured.ws, 'current-pressured');
    const joined = pressured.messages.find((message) => message.type === 'joined');
    assert.ok(joined?.data && typeof joined.data === 'object' && !Array.isArray(joined.data));
    const resumeToken = (joined.data as Record<string, unknown>)['resumeToken'];
    assert.equal(typeof resumeToken, 'string');

    join(handler, peer.ws, 'peer');
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
    join(handler, snapshot.ws, 'projected-snapshot');
    join(handler, event.ws, 'projected-event');
    join(handler, control.ws, 'projected-control');
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
    join(handler, pilot.ws, 'oversized-snapshot');
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
    join(handler, first.ws, 'first');
    join(handler, second.ws, 'second');
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
    join(handler, pilot.ws, 'pilot');
    const actor = engine.getPlayer('pilot');
    assert.ok(actor);
    const oldEpoch = actor.asteroidMotion?.epoch;
    assert.ok(oldEpoch);
    engine.prepareDiagnosticWorld('combat');
    expect(engine.getPlayer('pilot')).toBe(actor);
    expect(actor.ws).toBe(pilot.ws);
    expect(
      engine.asteroidMotion.placeActorForTesting('pilot', { x: 100, y: 0 }, engine.getServerTime())
    ).toBe(true);
    expect(actor.asteroidMotion?.epoch).toBe(oldEpoch + 1);
    expect(engine.getDiagnostics()).toMatchObject({
      humanPlayers: 1,
      bots: 2,
      asteroids: 80,
      satellites: 6,
      satellitePickups: 2,
    });
    expect(engine.getPlayerProjectiles()).toHaveLength(0);
    const firstRocks = normalizeFixtureAsteroids(engine.getAllAsteroids());
    engine.prepareDiagnosticWorld('combat');
    expect(normalizeFixtureAsteroids(engine.getAllAsteroids())).toEqual(firstRocks);
    expect(pilot.close).not.toHaveBeenCalled();
  });

  test('fixture readiness waits for a new keyframe after a pending transport send', () => {
    const pilot = socket();
    join(handler, pilot.ws, 'pilot');
    pilot.fake.defer = true;
    broadcaster.broadcastGameState();
    const sequence = broadcaster.requestSnapshotKeyframe(pilot.ws);
    const complete = pilot.pending.shift();
    assert.ok(complete);
    complete();
    broadcaster.broadcastGameState();
    expect(pilot.messages.at(-1)).toMatchObject({
      type: 'snapshot',
      data: { kind: 'keyframe', sequence },
    });
    expect(sequence).toBeGreaterThan(1);
  });
});
