/* @vitest-environment node */

import { performance as nodePerformance } from 'node:perf_hooks';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { WebSocketCore } from '../../../server/communication/WebSocketCore';
import { GameEngine } from '../../../server/core/GameEngine';
import { logger } from '../../../setup/serverLogger';
import { RecordingSocket } from '../../support/recordingSocket';

let engine: GameEngine;
let core: WebSocketCore;
let monotonicNowMs = 0;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(10_000);
  monotonicNowMs = 1_000;
  vi.spyOn(nodePerformance, 'now').mockImplementation(() => monotonicNowMs);
  engine = new GameEngine(17);
  core = new WebSocketCore(engine);
});
afterEach(() => {
  engine.stopGameLoop();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function advanceElapsed(ms: number): void {
  monotonicNowMs += ms;
  vi.advanceTimersByTime(ms);
}

test('alternating enhanced-motion rejects stay within one bounded socket summary', () => {
  const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  const { socket } = join('enhanced-pilot');
  const rejectedPose = {
    type: 'update',
    id: 'enhanced-pilot',
    data: {
      position: { x: 0, y: 0 },
      velocity: { x: 0, y: 0 },
      angle: 0,
      thrusting: false,
      motionEpoch: 99,
      motionSequence: 1,
    },
  };

  core.handleClientMessage(rejectedPose, socket);
  advanceElapsed(1_000);
  core.handleClientMessage(
    {
      type: 'asteroidInput',
      data: { epoch: 1, sequence: 1, thrust: false, turn: 0, aimAngle: 0 },
    },
    socket
  );
  advanceElapsed(1_000);
  core.handleClientMessage(rejectedPose, socket);
  advanceElapsed(4_000);
  vi.setSystemTime(9_000);
  core.handleClientMessage(rejectedPose, socket);

  const rejected = warn.mock.calls.filter(
    ([category, event]) => category === 'STATE' && event === 'motion_command_rejected'
  );
  expect(rejected).toHaveLength(2);
  expect(rejected[0]?.[2]).toMatchObject({ receivedAt: 10_000 });
  expect(rejected[1]?.[2]).toMatchObject({
    receivedAt: 9_000,
    playerId: 'enhanced-pilot',
    commandType: 'update',
    reason: 'Invalid or stale enhanced movement pose',
    receivedEpoch: 99,
    receivedSequence: 1,
    motionEpoch: 1,
    suppressed: 2,
  });
});
function join(id: string) {
  const socket = new RecordingSocket();
  core.handleClientMessage(
    {
      type: 'join',
      data: { id, name: id, snapshotVersion: 1, asteroidInteractions: 1 },
    },
    socket
  );
  socket.inbox.length = 0;
  return { socket, messages: socket.inbox };
}

test('a pre-acknowledgment pose is ignored without a spurious enhanced-movement warning', () => {
  const { socket, messages } = join('enhanced-pilot');
  const pilot = engine.getPlayer('enhanced-pilot');
  if (!pilot) {
    throw new Error('Expected the enhanced pilot to join');
  }
  const before = { ...pilot.position };
  core.handleClientMessage(
    {
      type: 'update',
      id: 'enhanced-pilot',
      data: { position: { x: 123, y: 456 }, velocity: { x: 0, y: 0 }, angle: 0, thrusting: false },
    },
    socket
  );
  expect(engine.getPlayer('enhanced-pilot')?.position).toEqual(before);
  expect(messages.some((message) => message.type === 'error')).toBe(false);
});

test('chat cannot impersonate another pilot and only bounded text reaches peers', () => {
  const owner = join('owner');
  const peer = join('peer');
  owner.messages.length = 0;
  core.handleClientMessage({ type: 'chat', id: 'peer', data: { message: 'spoof' } }, owner.socket);
  expect(peer.messages.some((message) => message.type === 'chat')).toBe(false);
  core.handleClientMessage(
    { type: 'chat', id: 'owner', data: { message: '  Hello  ' } },
    owner.socket
  );
  expect(peer.messages.find((message) => message.type === 'chat')?.data).toMatchObject({
    id: 'owner',
    name: 'owner',
    message: 'Hello',
  });
  const count = peer.messages.length;
  for (const message of ['', 'x'.repeat(501), { text: 'invalid' }]) {
    core.handleClientMessage({ type: 'chat', id: 'owner', data: { message } }, owner.socket);
  }
  expect(peer.messages).toHaveLength(count);
});
