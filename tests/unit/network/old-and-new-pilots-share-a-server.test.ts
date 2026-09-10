import { afterEach, assert, beforeEach, describe, expect, test, vi } from 'vitest';
import { WebSocket } from 'ws';
import { MessageHandler } from '../../../server/communication/MessageHandler';
import { GameEngine } from '../../../server/core/GameEngine';
import { GameStateBroadcaster } from '../../../server/services/GameStateBroadcaster';
import { logger } from '../../../setup/serverLogger';
import {
  SNAPSHOT_BACKPRESSURE_BYTES,
  SNAPSHOT_KEYFRAME_INTERVAL,
  SnapshotDecoder,
} from '../../../shared/snapshotProtocol';

type RecordedMessageData = Record<string, unknown> & {
  kind?: string;
  loot?: Array<{ id: string; kind: string }>;
  serverReleaseId?: string;
  snapshotVersion?: number;
  asteroidInteractions?: number;
  sequence?: number;
};

type RecordedMessage = {
  type: string;
  data: RecordedMessageData;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isRecordedLoot(value: unknown): value is { id: string; kind: string } {
  return isRecord(value) && typeof value['id'] === 'string' && typeof value['kind'] === 'string';
}

function isRecordedMessageData(value: Record<string, unknown>): value is RecordedMessageData {
  const loot = value['loot'];
  return (
    (value['kind'] === undefined || typeof value['kind'] === 'string') &&
    (value['serverReleaseId'] === undefined || typeof value['serverReleaseId'] === 'string') &&
    (value['snapshotVersion'] === undefined || typeof value['snapshotVersion'] === 'number') &&
    (value['asteroidInteractions'] === undefined ||
      typeof value['asteroidInteractions'] === 'number') &&
    (value['sequence'] === undefined || typeof value['sequence'] === 'number') &&
    (loot === undefined || (Array.isArray(loot) && loot.every(isRecordedLoot)))
  );
}

function parseRecordedMessage(text: string): RecordedMessage {
  const value: unknown = JSON.parse(text);
  if (
    !isRecord(value) ||
    typeof value['type'] !== 'string' ||
    !isRecord(value['data']) ||
    !isRecordedMessageData(value['data'])
  ) {
    throw new Error('Expected a structured server message');
  }
  return { ...value, type: value['type'], data: value['data'] };
}

function findMessage(messages: RecordedMessage[], type: string): RecordedMessage {
  const message = messages.find((candidate) => candidate.type === type);
  assert.exists(message);
  return message;
}

function lastMessage(messages: RecordedMessage[]): RecordedMessage {
  const message = messages.at(-1);
  assert.exists(message);
  return message;
}

function socket() {
  const messages: RecordedMessage[] = [];
  const pending: Array<(error?: Error) => void> = [];
  const fake = {
    readyState: WebSocket.OPEN,
    bufferedAmount: 0,
    defer: false,
    fail: false,
    send: vi.fn((text: string, done?: (error?: Error) => void) => {
      if (fake.fail) {
        throw new Error('closed during send');
      }
      messages.push(parseRecordedMessage(text));
      if (done) {
        if (fake.defer) {
          pending.push(done);
        } else {
          done();
        }
      }
    }),
    close: vi.fn(),
  };
  return { fake, ws: fake as unknown as WebSocket, messages, pending };
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
    expect(findMessage(old.messages, 'joined').data).not.toHaveProperty('snapshotVersion');
    expect(findMessage(unsupported.messages, 'joined').data).not.toHaveProperty('snapshotVersion');
    expect(old.messages.some((m) => m.type === 'snapshot')).toBe(false);
    expect(modern.messages[0]).toMatchObject({ type: 'joined', data: { snapshotVersion: 1 } });
    expect(modern.messages[0]?.data.serverReleaseId).toEqual(expect.any(String));
    const legacy = old.messages.filter((m) => m.type === 'gameState').at(-1);
    assert.exists(legacy);
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
    expect(findMessage(b.messages, 'snapshot').data.kind).toBe('keyframe');
    const count = a.messages.length;
    broadcaster.broadcastGameState('a');
    expect(a.messages).toHaveLength(count);
    a.fake.bufferedAmount = SNAPSHOT_BACKPRESSURE_BYTES + 1;
    broadcaster.broadcastGameState();
    expect(a.messages).toHaveLength(count);
    a.fake.bufferedAmount = 0;
    broadcaster.broadcastGameState();
    expect(lastMessage(a.messages).data.kind).toBe('keyframe');
    join(handler, a.ws, 'a', 1);
    expect(lastMessage(a.messages).data).toMatchObject({ sequence: 1, kind: 'keyframe' });
    engine.removePlayer('a');
    const reconnected = socket();
    join(handler, reconnected.ws, 'a', 1);
    expect(lastMessage(reconnected.messages).data).toMatchObject({ sequence: 1, kind: 'keyframe' });
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
    assert.exists(core);
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
    const legacyGameState = lastMessage(
      legacy.messages.filter((message) => message.type === 'gameState')
    );
    assert.exists(legacyGameState.data.loot);
    const legacyCore = legacyGameState.data.loot.find((loot) => loot.id === core.id);
    assert.exists(legacyCore);
    expect(legacyCore.kind).toBe('shard');
    expect(
      decodeAll(enhanced)
        .at(-1)
        ?.loot.find((loot) => loot.id === core.id)?.kind
    ).toBe('laserCore');
    const collector = engine.getPlayer('recovery');
    assert.exists(collector);
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
    assert.exists(failedSend);
    failedSend(new Error('write failed'));
    a.fake.defer = false;
    broadcaster.broadcastGameState();
    expect(lastMessage(a.messages).data).toMatchObject({ sequence: 2, kind: 'keyframe' });
    for (let i = 0; i <= SNAPSHOT_KEYFRAME_INTERVAL; i++) {
      broadcaster.broadcastGameState();
    }
    expect(a.messages.slice(-2).some((m) => m.data.kind === 'keyframe')).toBe(true);
    handler.handleMessage({ type: 'snapshotResync' }, a.ws);
    broadcaster.broadcastGameState();
    expect(lastMessage(a.messages).data.kind).toBe('keyframe');
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
    old.fake.close.mockImplementation(() => {
      throw new Error('close failure');
    });
    expect(() => broadcaster.broadcastGameState()).not.toThrow();
    expect(old.fake.close).toHaveBeenCalled();
    expect(modern.fake.close).toHaveBeenCalledWith(1011, 'Snapshot encoding failed');
  });
});
