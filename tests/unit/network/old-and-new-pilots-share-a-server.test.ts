import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { WebSocket } from 'ws';
import { GameEngine } from '../../../server/core/GameEngine';
import { MessageHandler } from '../../../server/communication/MessageHandler';
import { GameStateBroadcaster } from '../../../server/services/GameStateBroadcaster';
import { SNAPSHOT_BACKPRESSURE_BYTES, SNAPSHOT_KEYFRAME_INTERVAL, SnapshotDecoder } from '../../../shared/snapshotProtocol';

function socket() {
  const messages: any[] = [];
  const pending: Array<(error?: Error) => void> = [];
  const fake = {
    readyState: WebSocket.OPEN, bufferedAmount: 0, defer: false, fail: false,
    send: vi.fn((text: string, done?: (error?: Error) => void) => {
      if (fake.fail) { throw new Error('closed during send'); }
      messages.push(JSON.parse(text));
      if (done) { if (fake.defer) { pending.push(done); } else { done(); } }
    }), close: vi.fn(),
  };
  return { fake, ws: fake as unknown as WebSocket, messages, pending };
}

describe('old and new pilots coexist on the production handler and broadcaster', () => {
  let engine: GameEngine;
  let broadcaster: GameStateBroadcaster;
  let handler: MessageHandler;
  beforeEach(() => { engine = new GameEngine(72); broadcaster = new GameStateBroadcaster(engine); handler = new MessageHandler(engine, broadcaster); });
  afterEach(() => { engine.stopGameLoop(); broadcaster.stopPeriodicBroadcast(); });
  const join = (handler: MessageHandler, ws: WebSocket, id: string, version?: number) => handler.handleMessage({ type: 'join', data: { id, name: id, position: { x: 100, y: 100 }, ...(version === undefined ? {} : { snapshotVersion: version }) } }, ws);

  test('legacy and unsupported offers retain exact gameState; supported offer is acknowledged first', () => {
    const old = socket(); const modern = socket(); const unsupported = socket();
    join(handler, old.ws, 'old'); join(handler, modern.ws, 'modern', 1); join(handler, unsupported.ws, 'unsupported', 200);
    broadcaster.broadcastGameState();
    expect(old.messages.find(m => m.type === 'joined').data).not.toHaveProperty('snapshotVersion');
    expect(unsupported.messages.find(m => m.type === 'joined').data).not.toHaveProperty('snapshotVersion');
    expect(old.messages.some(m => m.type === 'snapshot')).toBe(false);
    expect(modern.messages[0]).toMatchObject({ type: 'joined', data: { snapshotVersion: 1 } });
    const legacy = old.messages.filter(m => m.type === 'gameState').at(-1);
    expect(legacy.data).toEqual(JSON.parse(JSON.stringify(engine.getGameState())));
    expect(Object.keys(legacy).sort()).toEqual(['data', 'timestamp', 'type']);
    const decoder = new SnapshotDecoder();
    for (const message of modern.messages.filter(m => m.type === 'snapshot')) {
      decoder.decode(message.data);
    }
    expect(modern.messages.some(m => m.type === 'gameState')).toBe(false);
  });

  test('late joins, exclusions, backpressure, rejoin and reconnect have independent baselines', () => {
    const a = socket(); join(handler, a.ws, 'a', 1);
    const b = socket(); join(handler, b.ws, 'b', 1);
    expect(b.messages.find(m => m.type === 'snapshot').data.kind).toBe('keyframe');
    const count = a.messages.length;
    broadcaster.broadcastGameState('a');
    expect(a.messages).toHaveLength(count);
    a.fake.bufferedAmount = SNAPSHOT_BACKPRESSURE_BYTES + 1;
    broadcaster.broadcastGameState();
    expect(a.messages).toHaveLength(count);
    a.fake.bufferedAmount = 0;
    broadcaster.broadcastGameState();
    expect(a.messages.at(-1).data.kind).toBe('keyframe');
    join(handler, a.ws, 'a', 1);
    expect(a.messages.at(-1).data).toMatchObject({ sequence: 1, kind: 'keyframe' });
    engine.removePlayer('a');
    const reconnected = socket(); join(handler, reconnected.ws, 'a', 1);
    expect(reconnected.messages.at(-1).data).toMatchObject({ sequence: 1, kind: 'keyframe' });
  });

  test('pending and failed sends do not advance baseline; periodic/resync keyframes heal state', () => {
    const a = socket(); join(handler, a.ws, 'a', 1);
    a.fake.defer = true;
    broadcaster.broadcastGameState();
    broadcaster.broadcastGameState();
    a.pending.shift()!(new Error('write failed'));
    a.fake.defer = false;
    broadcaster.broadcastGameState();
    expect(a.messages.at(-1).data).toMatchObject({ sequence: 2, kind: 'keyframe' });
    for (let i = 0; i <= SNAPSHOT_KEYFRAME_INTERVAL; i++) { broadcaster.broadcastGameState(); }
    expect(a.messages.slice(-2).some(m => m.data.kind === 'keyframe')).toBe(true);
    handler.handleMessage({ type: 'snapshotResync' }, a.ws);
    broadcaster.broadcastGameState();
    expect(a.messages.at(-1).data.kind).toBe('keyframe');
    a.fake.fail = true;
    broadcaster.broadcastGameState();
    expect(a.fake.close).toHaveBeenCalledWith(1011, 'Snapshot encoding failed');
  });
  test('serialization and socket-close failures stay contained to recipients', () => {
    const old = socket(); const modern = socket();
    join(handler, old.ws, 'old'); join(handler, modern.ws, 'modern', 1);
    const broken = engine.getGameState();
    Object.assign(broken, { badField: broken });
    vi.spyOn(engine, 'getGameState').mockReturnValue(broken);
    old.fake.close.mockImplementation(() => { throw new Error('close failure'); });
    expect(() => broadcaster.broadcastGameState()).not.toThrow();
    expect(old.fake.close).toHaveBeenCalled();
    expect(modern.fake.close).toHaveBeenCalledWith(1011, 'Snapshot encoding failed');
  });

});
