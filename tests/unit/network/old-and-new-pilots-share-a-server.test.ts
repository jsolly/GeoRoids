import { strict as assert } from 'node:assert';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { MessageHandler } from '../../../server/communication/MessageHandler';
import { GameEngine } from '../../../server/core/GameEngine';
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

describe('old and new pilots coexist on the production handler and broadcaster', () => {
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
  const join = (handler: MessageHandler, ws: WebSocket, id: string, version?: number) =>
    handler.handleMessage(
      {
        type: 'join',
        data: {
          id,
          name: id,
          position: { x: 100, y: 100 },
          ...(version === undefined ? {} : { snapshotVersion: version }),
        },
      },
      ws
    );

  test('legacy and unsupported offers retain exact gameState; supported offer is acknowledged first', () => {
    const old = socket();
    const modern = socket();
    const unsupported = socket();
    join(handler, old.ws, 'old');
    join(handler, modern.ws, 'modern', 1);
    join(handler, unsupported.ws, 'unsupported', 200);
    broadcaster.broadcastGameState();
    const legacyJoined = old.messages.find((m) => m.type === 'joined');
    assert.ok(legacyJoined, 'legacy joined message');
    expect(legacyJoined).not.toMatchObject({ data: { snapshotVersion: expect.anything() } });
    const unsupportedJoined = unsupported.messages.find((m) => m.type === 'joined');
    assert.ok(unsupportedJoined, 'unsupported joined message');
    expect(unsupportedJoined).not.toMatchObject({ data: { snapshotVersion: expect.anything() } });
    expect(old.messages.some((m) => m.type === 'snapshot')).toBe(false);
    const modernJoined = modern.messages[0];
    assert.ok(modernJoined, 'modern joined message');
    expect(modernJoined).toMatchObject({
      type: 'joined',
      data: { snapshotVersion: 1, serverReleaseId: expect.any(String) },
    });
    const legacy = old.messages.filter((m) => m.type === 'gameState').at(-1);
    assert.ok(legacy, 'legacy gameState message');
    expect(legacy.data).toEqual(JSON.parse(JSON.stringify(engine.getGameState())));
    expect(Object.keys(legacy).sort()).toEqual(['data', 'timestamp', 'type']);
    const decoder = new SnapshotDecoder();
    for (const message of modern.messages.filter((m) => m.type === 'snapshot')) {
      decoder.decode(message.data);
    }
    expect(modern.messages.some((m) => m.type === 'gameState')).toBe(false);
  });

  test('a sampled snapshot is logged only after its transport callback succeeds', () => {
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    const pilot = socket();
    pilot.fake.defer = true;
    join(handler, pilot.ws, 'sampled-pilot', 1);
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
    join(handler, a.ws, 'a', 1);
    const b = socket();
    join(handler, b.ws, 'b', 1);
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
    join(handler, a.ws, 'a', 1);
    const rejoinedKeyframe = a.messages.at(-1);
    assert.ok(rejoinedKeyframe, 'rejoined pilot a keyframe');
    expect(rejoinedKeyframe.data).toMatchObject({
      sequence: 1,
      kind: 'keyframe',
    });
    engine.removePlayer('a');
    const reconnected = socket();
    join(handler, reconnected.ws, 'a', 1);
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

  test('a laser core stays collectible while older pilots decode both keyframes and deltas', () => {
    const legacy = socket();
    const recovery = socket();
    const enhanced = socket();
    join(handler, legacy.ws, 'legacy');
    join(handler, recovery.ws, 'recovery', 1);
    handler.handleMessage(
      {
        type: 'join',
        data: {
          id: 'enhanced',
          name: 'enhanced',
          position: { x: 100, y: 100 },
          snapshotVersion: 1,
          asteroidInteractions: 1,
        },
      },
      enhanced.ws
    );
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
      engine.handleAsteroidHit('core-rock', 'enhanced');
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
    // The deployed a975 client accepts exactly these enum values. Unknown
    // additive fields are safe, but a new loot enum rejects the whole world.
    const deployedLootKinds = ['shard', 'wreckage', 'fuel'];
    for (const state of decodeAll(recovery)) {
      expect(state.loot.every((loot) => deployedLootKinds.includes(loot.kind))).toBe(true);
    }
    expect(
      decodeAll(recovery)
        .at(-1)
        ?.loot.find((loot) => loot.id === core.id)?.kind
    ).toBe('shard');
    const legacyState = legacy.messages.filter((message) => message.type === 'gameState').at(-1);
    assert.ok(legacyState, 'legacy game state');
    expect(legacyState).toMatchObject({
      data: {
        loot: expect.arrayContaining([expect.objectContaining({ id: core.id, kind: 'shard' })]),
      },
    });
    expect(
      decodeAll(enhanced)
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
      decodeAll(enhanced)
        .at(-1)
        ?.loot.some((loot) => loot.id === core.id)
    ).toBe(false);
  });

  test('pending and failed sends do not advance baseline; periodic/resync keyframes heal state', () => {
    const a = socket();
    join(handler, a.ws, 'a', 1);
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
  test('serialization and socket-close failures stay contained to recipients', () => {
    const old = socket();
    const modern = socket();
    join(handler, old.ws, 'old');
    join(handler, modern.ws, 'modern', 1);
    const broken = engine.getGameState();
    Object.assign(broken, { badField: broken });
    vi.spyOn(engine, 'getGameState').mockReturnValue(broken);
    old.close.mockImplementation(() => {
      throw new Error('close failure');
    });
    expect(() => broadcaster.broadcastGameState()).not.toThrow();
    expect(old.fake.close).toHaveBeenCalled();
    expect(modern.fake.close).toHaveBeenCalledWith(1011, 'Snapshot encoding failed');
  });
});
