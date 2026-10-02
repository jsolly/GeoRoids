/* @vitest-environment node */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { MessageHandler } from '../../../server/communication/MessageHandler';
import { GameEngine } from '../../../server/core/GameEngine';
import { GameStateBroadcaster } from '../../../server/services/GameStateBroadcaster';
import { SNAPSHOT_VERSION, SnapshotDecoder } from '../../../shared/snapshotProtocol';
import { RecordingSocket } from '../../support/recordingSocket';

type SendCallback = (error?: Error) => void;
type SendData = Parameters<RecordingSocket['send']>[0];
type SendOptions = { mask?: boolean; binary?: boolean; compress?: boolean; fin?: boolean };

class DeferredSocket extends RecordingSocket {
  defer = false;
  readonly completions: SendCallback[] = [];

  override send(data: SendData, callback?: SendCallback): void;
  override send(data: SendData, options: SendOptions, callback?: SendCallback): void;
  override send(
    data: SendData,
    optionsOrCallback?: SendOptions | SendCallback,
    callback?: SendCallback
  ): void {
    if (typeof optionsOrCallback === 'object') {
      super.send(data, optionsOrCallback, callback);
      return;
    }
    super.send(data);
    const completed = optionsOrCallback ?? callback;
    if (completed) {
      if (this.defer) {
        this.completions.push(completed);
      } else {
        completed();
      }
    }
  }
}

let engine: GameEngine;
let broadcaster: GameStateBroadcaster;
let handler: MessageHandler;
let socket: DeferredSocket;
let decoder: SnapshotDecoder;
let cursor: number;

function applyReceived(acknowledge = true) {
  const applied: Extract<ReturnType<SnapshotDecoder['readMessage']>, { kind: 'snapshot' }>[] = [];
  while (cursor < socket.sent.length) {
    const raw = socket.sent[cursor++];
    assert(raw);
    const result = decoder.readMessage(raw, { acceptSnapshots: true });
    if (result.kind === 'snapshot-rejected') {
      throw result.error;
    }
    if (result.kind === 'snapshot') {
      applied.push(result);
      if (acknowledge) {
        handler.handleMessage(
          { type: 'snapshotAck', data: { sequence: result.metadata.sequence } },
          socket
        );
      }
    } else if (
      result.message &&
      typeof result.message === 'object' &&
      'type' in result.message &&
      result.message.type === 'joined'
    ) {
      decoder.reset();
    }
  }
  return applied;
}

function resumeToken(): string {
  const joined = socket.lastReceived('joined')?.data;
  assert(joined && typeof joined === 'object' && 'resumeToken' in joined);
  assert.equal(typeof joined.resumeToken, 'string');
  assert(typeof joined.resumeToken === 'string');
  return joined.resumeToken;
}

beforeEach(() => {
  engine = new GameEngine(72);
  // The scenarios isolate application credit from changing terrain membership.
  for (const rock of engine.getAllAsteroids()) {
    engine.removeAsteroid(rock.id);
  }
  broadcaster = new GameStateBroadcaster(engine);
  handler = new MessageHandler(engine, broadcaster);
  socket = new DeferredSocket();
  decoder = new SnapshotDecoder();
  cursor = 0;
  handler.handleMessage(
    {
      type: 'join',
      data: {
        id: 'pilot',
        name: 'Pilot',
        snapshotVersion: SNAPSHOT_VERSION,
        asteroidInteractions: 1,
      },
    },
    socket
  );
  const first = applyReceived();
  expect(first).toHaveLength(1);
  expect(first[0]?.metadata).toMatchObject({ sequence: 1, kind: 'keyframe' });
});

afterEach(() => {
  broadcaster.stopPeriodicBroadcast();
  engine.stopGameLoop();
  vi.restoreAllMocks();
});

test('a slow pilot receives eight pipelined worlds and then the current world without a stale queue', () => {
  const player = engine.getPlayer('pilot');
  assert(player);
  for (let index = 0; index < 8; index++) {
    player.position.x = index + 1;
    broadcaster.broadcastGameState();
  }
  const waiting = applyReceived(false);
  expect(waiting).toHaveLength(8);
  expect(waiting.map((value) => value.metadata.sequence)).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
  const prepare = vi.spyOn(engine, 'getSnapshotState');
  player.position.x = 999;
  for (let index = 0; index < 20; index++) {
    broadcaster.broadcastGameState();
  }
  expect(prepare).not.toHaveBeenCalled();
  expect(applyReceived(false)).toEqual([]);
  handler.handleMessage({ type: 'snapshotAck', data: { sequence: 9 } }, socket);
  broadcaster.broadcastGameState();
  const current = applyReceived();
  expect(current).toHaveLength(1);
  expect(current[0]?.metadata).toEqual({ kind: 'delta', sequence: 10, baseline: 9 });
  expect(current[0]?.state.entities.find((row) => row.id === 'pilot')?.position.x).toBe(999);
});

test('a forged future receipt and an unjoined socket cannot grant more applied-world credit', () => {
  for (let index = 0; index < 8; index++) {
    broadcaster.broadcastGameState();
  }
  applyReceived(false);
  expect(broadcaster.acknowledgeSnapshot(socket, 1000)).toBe(false);
  expect(broadcaster.acknowledgeSnapshot(new RecordingSocket(), 9)).toBe(false);
  const prepare = vi.spyOn(engine, 'getSnapshotState');
  broadcaster.broadcastGameState();
  expect(prepare).not.toHaveBeenCalled();
  expect(broadcaster.acknowledgeSnapshot(socket, 9)).toBe(true);
  expect(broadcaster.acknowledgeSnapshot(socket, 9)).toBe(true);
  expect(broadcaster.acknowledgeSnapshot(socket, 8)).toBe(false);
  broadcaster.broadcastGameState();
  expect(applyReceived()[0]?.metadata.sequence).toBe(10);
});

test('byte credit caps larger ordinary deltas before the snapshot-count limit', () => {
  const original = engine.getSnapshotState.bind(engine);
  let currentPayload = 'a'.repeat(24 * 1024);
  vi.spyOn(engine, 'getSnapshotState').mockImplementation(() => ({
    ...original(),
    futurePayload: currentPayload,
  }));
  broadcaster.broadcastGameState();
  currentPayload = 'b'.repeat(24 * 1024);
  broadcaster.broadcastGameState();
  currentPayload = 'c'.repeat(24 * 1024);
  broadcaster.broadcastGameState();
  const waiting = applyReceived(false);
  expect(waiting.map((value) => value.metadata.sequence)).toEqual([2, 3]);
  const chargedBytes = socket.sent
    .filter((raw) => {
      const envelope: unknown = JSON.parse(raw);
      return (
        envelope !== null &&
        typeof envelope === 'object' &&
        'type' in envelope &&
        envelope.type === 'snapshot'
      );
    })
    .slice(1)
    .reduce((total, raw) => total + Buffer.byteLength(raw, 'utf8') + 10, 0);
  expect(chargedBytes).toBeLessThanOrEqual(64 * 1024);
  expect(chargedBytes).toBeGreaterThan(48 * 1024);
  handler.handleMessage({ type: 'snapshotAck', data: { sequence: 3 } }, socket);
  broadcaster.broadcastGameState();
  const fresh = applyReceived();
  expect(fresh[0]?.metadata).toEqual({ kind: 'delta', sequence: 4, baseline: 3 });
  expect(fresh[0]?.state).toHaveProperty('futurePayload', currentPayload);
});

test('a socket replaced by a resumed pilot cannot release the replacement socket credit', () => {
  const superseded = socket;
  const token = resumeToken();
  broadcaster.broadcastGameState();
  applyReceived(false);
  socket = new DeferredSocket();
  decoder = new SnapshotDecoder();
  cursor = 0;
  handler.handleMessage(
    {
      type: 'join',
      data: {
        id: 'pilot',
        name: 'Pilot',
        resumeToken: token,
        snapshotVersion: SNAPSHOT_VERSION,
        asteroidInteractions: 1,
      },
    },
    socket
  );
  expect(applyReceived()[0]?.metadata).toMatchObject({ sequence: 1, kind: 'keyframe' });
  for (let index = 0; index < 8; index++) {
    broadcaster.broadcastGameState();
  }
  applyReceived(false);
  expect(broadcaster.acknowledgeSnapshot(superseded, 2)).toBe(false);
  handler.handleMessage({ type: 'snapshotAck', data: { sequence: 9 } }, superseded);
  const prepare = vi.spyOn(engine, 'getSnapshotState');
  broadcaster.broadcastGameState();
  expect(prepare).not.toHaveBeenCalled();
  expect(broadcaster.acknowledgeSnapshot(socket, 9)).toBe(true);
  broadcaster.broadcastGameState();
  expect(applyReceived()[0]?.metadata.sequence).toBe(10);
});

test('a decode failure with a full window gets one reserved keyframe and then resumes deltas', () => {
  for (let index = 0; index < 8; index++) {
    broadcaster.broadcastGameState();
  }
  applyReceived(false);
  handler.handleMessage({ type: 'snapshotResync' }, socket);
  broadcaster.broadcastGameState();
  const replacement = applyReceived(false);
  expect(replacement).toHaveLength(1);
  expect(replacement[0]?.metadata).toMatchObject({ kind: 'keyframe', sequence: 10 });
  for (let index = 0; index < 20; index++) {
    handler.handleMessage({ type: 'snapshotResync' }, socket);
    broadcaster.broadcastGameState();
  }
  expect(applyReceived(false)).toEqual([]);
  handler.handleMessage({ type: 'snapshotAck', data: { sequence: 10 } }, socket);
  broadcaster.broadcastGameState();
  expect(applyReceived()[0]?.metadata).toEqual({ kind: 'delta', sequence: 11, baseline: 10 });
});

test('an applied receipt racing a transport callback does not publish an unaccepted baseline', () => {
  socket.defer = true;
  broadcaster.broadcastGameState();
  expect(applyReceived()[0]?.metadata.sequence).toBe(2);
  const prepare = vi.spyOn(engine, 'getSnapshotState');
  broadcaster.broadcastGameState();
  expect(prepare).not.toHaveBeenCalled();
  const complete = socket.completions.shift();
  assert(complete);
  complete();
  socket.defer = false;
  broadcaster.broadcastGameState();
  expect(applyReceived()[0]?.metadata).toEqual({ kind: 'delta', sequence: 3, baseline: 2 });
});

test('same-socket rejoin preserves transport debt and unique sequences while replacing its baseline', () => {
  const token = resumeToken();
  socket.defer = true;
  broadcaster.broadcastGameState();
  expect(applyReceived(false)[0]?.metadata.sequence).toBe(2);
  handler.handleMessage(
    {
      type: 'join',
      data: {
        id: 'pilot',
        name: 'Pilot',
        resumeToken: token,
        snapshotVersion: SNAPSHOT_VERSION,
        asteroidInteractions: 1,
      },
    },
    socket
  );
  expect(applyReceived(false)).toEqual([]);
  const prepare = vi.spyOn(engine, 'getSnapshotState');
  broadcaster.broadcastGameState();
  expect(prepare).not.toHaveBeenCalled();
  // This old world was successfully applied before joined reset the decoder.
  // Its receipt still belongs to the same socket, and the callback must settle
  // before that receipt can retire debt and admit a possibly oversized keyframe.
  handler.handleMessage({ type: 'snapshotAck', data: { sequence: 2 } }, socket);
  broadcaster.broadcastGameState();
  expect(prepare).not.toHaveBeenCalled();
  const complete = socket.completions.shift();
  assert(complete);
  complete();
  socket.defer = false;
  broadcaster.broadcastGameState();
  const replacement = applyReceived();
  expect(replacement[0]?.metadata).toMatchObject({ sequence: 3, kind: 'keyframe' });
  expect(broadcaster.acknowledgeSnapshot(socket, 2)).toBe(false);
  broadcaster.broadcastGameState();
  expect(applyReceived()[0]?.metadata).toEqual({ kind: 'delta', sequence: 4, baseline: 3 });
});

test('applied worlds from before a full-window rejoin release credit for its fresh keyframe', () => {
  const token = resumeToken();
  for (let index = 0; index < 8; index++) {
    broadcaster.broadcastGameState();
  }
  expect(applyReceived(false).at(-1)?.metadata.sequence).toBe(9);
  handler.handleMessage(
    {
      type: 'join',
      data: {
        id: 'pilot',
        name: 'Pilot',
        resumeToken: token,
        snapshotVersion: SNAPSHOT_VERSION,
        asteroidInteractions: 1,
      },
    },
    socket
  );
  expect(applyReceived(false)).toEqual([]);
  const prepare = vi.spyOn(engine, 'getSnapshotState');
  broadcaster.broadcastGameState();
  expect(prepare).not.toHaveBeenCalled();
  handler.handleMessage({ type: 'snapshotAck', data: { sequence: 9 } }, socket);
  broadcaster.broadcastGameState();
  expect(applyReceived()[0]?.metadata).toMatchObject({ sequence: 10, kind: 'keyframe' });
  broadcaster.broadcastGameState();
  expect(applyReceived()[0]?.metadata).toEqual({ kind: 'delta', sequence: 11, baseline: 10 });
});

test('a pending decode recovery survives same-socket rejoin with a full application window', () => {
  const token = resumeToken();
  for (let index = 0; index < 8; index++) {
    broadcaster.broadcastGameState();
  }
  expect(applyReceived(false).at(-1)?.metadata.sequence).toBe(9);
  handler.handleMessage({ type: 'snapshotResync' }, socket);
  handler.handleMessage(
    {
      type: 'join',
      data: {
        id: 'pilot',
        name: 'Pilot',
        resumeToken: token,
        snapshotVersion: SNAPSHOT_VERSION,
        asteroidInteractions: 1,
      },
    },
    socket
  );
  // Join broadcasts immediately after its ordered acknowledgment. Preserved
  // recovery credit admits that keyframe despite eight older unreceipted worlds.
  const recovery = applyReceived(false);
  expect(recovery).toHaveLength(1);
  expect(recovery[0]?.metadata).toMatchObject({ sequence: 10, kind: 'keyframe' });
  const prepare = vi.spyOn(engine, 'getSnapshotState');
  for (let index = 0; index < 20; index++) {
    handler.handleMessage({ type: 'snapshotResync' }, socket);
    broadcaster.broadcastGameState();
  }
  expect(prepare).not.toHaveBeenCalled();
  expect(applyReceived(false)).toEqual([]);
  handler.handleMessage({ type: 'snapshotAck', data: { sequence: 10 } }, socket);
  broadcaster.broadcastGameState();
  expect(applyReceived()[0]?.metadata).toEqual({ kind: 'delta', sequence: 11, baseline: 10 });
});

test('a non-applying pilot cannot stay connected forever by receiving pongs', () => {
  const now = globalThis.performance.now();
  const clock = vi.spyOn(globalThis.performance, 'now').mockReturnValue(now);
  broadcaster.broadcastGameState();
  applyReceived(false);
  clock.mockReturnValue(now + 751);
  const prepare = vi.spyOn(engine, 'getSnapshotState');
  broadcaster.broadcastGameState();
  expect(prepare).not.toHaveBeenCalled();
  expect(socket.readyState).toBe(socket.OPEN);
  clock.mockReturnValue(now + 6001);
  broadcaster.broadcastGameState();
  expect(socket.readyState).toBe(socket.CLOSED);
  expect(engine.getPlayer('pilot')?.ws).toBeUndefined();
});

test('an indivisible large world travels alone and a rejected one reconnects instead of queuing a second', () => {
  const original = engine.getSnapshotState.bind(engine);
  vi.spyOn(engine, 'getSnapshotState').mockImplementation(() => ({
    ...original(),
    futurePayload: 'x'.repeat(80 * 1024),
  }));
  broadcaster.requestSnapshotKeyframe(socket);
  broadcaster.broadcastGameState();
  expect(applyReceived(false)[0]?.metadata).toMatchObject({ kind: 'keyframe', sequence: 2 });
  const prepare = vi.spyOn(engine, 'getSnapshotState');
  prepare.mockClear();
  broadcaster.broadcastGameState();
  expect(prepare).not.toHaveBeenCalled();
  handler.handleMessage({ type: 'snapshotResync' }, socket);
  expect(socket.readyState).toBe(socket.CLOSED);
  expect(engine.getPlayer('pilot')?.ws).toBeUndefined();
});
