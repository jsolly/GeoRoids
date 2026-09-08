/* @vitest-environment node */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { WebSocket } from 'ws';
import { WebSocketCore } from '../../../server/communication/WebSocketCore';
import { GameEngine } from '../../../server/core/GameEngine';
import { logger } from '../../../setup/serverLogger';

let engine: GameEngine;
let core: WebSocketCore;
beforeEach(() => {
  engine = new GameEngine(17);
  core = new WebSocketCore(engine);
});
afterEach(() => {
  engine.stopGameLoop();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test('alternating enhanced-motion rejects stay within one bounded socket summary', () => {
  vi.useFakeTimers();
  vi.setSystemTime(10_000);
  const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  const { socket } = join('enhanced-pilot', true);
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
  vi.setSystemTime(11_000);
  core.handleClientMessage(
    {
      type: 'asteroidInput',
      data: { epoch: 1, sequence: 1, thrust: false, turn: 0, aimAngle: 0 },
    },
    socket
  );
  vi.setSystemTime(12_000);
  core.handleClientMessage(rejectedPose, socket);
  vi.setSystemTime(16_000);
  core.handleClientMessage(rejectedPose, socket);

  const rejected = warn.mock.calls.filter(
    ([category, event]) => category === 'STATE' && event === 'motion_command_rejected'
  );
  expect(rejected).toHaveLength(2);
  expect(rejected[1]?.[2]).toMatchObject({
    playerId: 'enhanced-pilot',
    commandType: 'update',
    reason: 'Invalid or stale enhanced movement pose',
    receivedEpoch: 99,
    receivedSequence: 1,
    motionEpoch: 1,
    suppressed: 2,
  });
});
function join(id: string, enhanced = false) {
  const messages: Array<{ type: string; data: Record<string, unknown> }> = [];
  const socket = {
    readyState: WebSocket.OPEN,
    send: (text: string) => messages.push(JSON.parse(text)),
    close: vi.fn(),
  } as unknown as WebSocket;
  core.handleClientMessage(
    {
      type: 'join',
      data: { id, name: id, ...(enhanced ? { snapshotVersion: 1, asteroidInteractions: 1 } : {}) },
    },
    socket
  );
  messages.length = 0;
  return { socket, messages };
}

test('a pre-acknowledgment pose is ignored without a spurious enhanced-movement warning', () => {
  const { socket, messages } = join('enhanced-pilot', true);
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
