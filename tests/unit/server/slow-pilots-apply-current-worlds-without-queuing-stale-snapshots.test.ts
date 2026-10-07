/* @vitest-environment node */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { MessageHandler } from '../../../server/communication/MessageHandler';
import { GameEngine } from '../../../server/core/GameEngine';
import { GameStateBroadcaster } from '../../../server/services/GameStateBroadcaster';
import { SNAPSHOT_VERSION, SnapshotDecoder } from '../../../shared/snapshotProtocol';
import { RecordingSocket } from '../../support/recordingSocket';

let engine: GameEngine;
let broadcaster: GameStateBroadcaster;
let handler: MessageHandler;
let socket: RecordingSocket;
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

beforeEach(() => {
  engine = new GameEngine(72);
  // The scenarios isolate application credit from changing terrain membership.
  for (const rock of engine.getAllAsteroids()) {
    engine.removeAsteroid(rock.id);
  }
  broadcaster = new GameStateBroadcaster(engine);
  handler = new MessageHandler(engine, broadcaster);
  socket = new RecordingSocket();
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
