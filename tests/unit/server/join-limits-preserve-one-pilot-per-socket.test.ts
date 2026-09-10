/* @vitest-environment node */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { WebSocketCore } from '../../../server/communication/WebSocketCore';
import { GameEngine } from '../../../server/core/GameEngine';
import { RecordingSocket } from '../../support/recordingSocket';

let engine: GameEngine;
let core: WebSocketCore;
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

beforeEach(() => {
  engine = new GameEngine(17);
  core = new WebSocketCore(engine);
});
afterEach(() => engine.stopGameLoop());
function transport() {
  const socket = new RecordingSocket();
  vi.spyOn(socket, 'close');
  return {
    socket,
    replies() {
      return socket.inbox.filter(
        (message) => message.type === 'joined' || message.type === 'error'
      );
    },
  };
}
function join(socket: RecordingSocket, id: string, name = id) {
  core.handleClientMessage(
    {
      type: 'join',
      data: { id, name, snapshotVersion: 1, asteroidInteractions: 1 },
    },
    socket
  );
}

test('a socket cannot create a second pilot and repeat flooding closes the transport', () => {
  const { socket, replies } = transport();
  join(socket, 'pilot');
  for (let i = 0; i < 5; i++) {
    join(socket, `extra-${i}`);
  }
  expect(
    engine
      .getAllPlayers()
      .filter((player) => player.type === 'human')
      .map((p) => p.id)
  ).toEqual(['pilot']);
  expect(replies().filter((reply) => reply.type === 'joined')).toHaveLength(1);
  expect(socket.close).toHaveBeenCalledWith(1008, 'Too many join requests');
});

test.each([
  ['x'.repeat(129), 'Pilot'],
  ['pilot', 'é'.repeat(33)],
  ['pilot\nforged', 'Pilot'],
])('oversized or control-bearing identity %s is rejected before entering the world', (id, name) => {
  const { socket, replies } = transport();
  join(socket, id, name);
  expect(engine.getPlayerCount()).toBe(0);
  expect(replies().map((reply) => reply.type)).toEqual(['error']);
});

test('a full server refuses a new pilot without disturbing the existing population', () => {
  for (let i = 0; i < 100; i++) {
    engine.addPlayer(`pilot-${i}`, `Pilot ${i}`, transport().socket, { x: 0, y: 0 });
  }
  const { socket, replies } = transport();
  join(socket, 'overflow');
  expect(engine.getPlayerCount()).toBe(100);
  expect(engine.getPlayer('overflow')).toBeUndefined();
  expect(replies().map((reply) => reply.type)).toEqual(['error']);
});

test('a case-variant name cannot bypass the full-server player cap', () => {
  for (let i = 0; i < 100; i++) {
    engine.addPlayer(`pilot-${i}`, i === 0 ? 'Pilot' : `Pilot ${i}`, transport().socket, {
      x: 0,
      y: 0,
    });
  }
  const { socket, replies } = transport();

  join(socket, 'attacker', 'pilot');

  expect(engine.getPlayerCount()).toBe(100);
  expect(engine.getPlayer('attacker')).toBeUndefined();
  expect(replies().map((reply) => reply.type)).toEqual(['error']);
});

test('a current pilot cannot be claimed without its private resume token', () => {
  const owner = transport();
  const data = { id: 'owner', name: 'Owner', asteroidInteractions: 1, snapshotVersion: 1 };
  core.handleClientMessage({ type: 'join', data }, owner.socket);
  const joined = owner.replies().find((reply) => reply.type === 'joined');
  if (!joined || !isRecord(joined.data) || typeof joined.data['resumeToken'] !== 'string') {
    throw new Error('Expected a joined reply with a resume token');
  }
  const token = joined.data['resumeToken'];
  expect(token).toEqual(expect.any(String));
  const attacker = transport();
  core.handleClientMessage({ type: 'join', data: { ...data, id: 'attacker' } }, attacker.socket);
  expect(attacker.replies().map((reply) => reply.type)).toEqual(['error']);
  expect(engine.getPlayer('owner')?.ws).toBe(owner.socket);
  expect(owner.socket.close).not.toHaveBeenCalled();
  const resumed = transport();
  core.handleClientMessage({ type: 'join', data: { ...data, resumeToken: token } }, resumed.socket);
  expect(engine.getPlayer('owner')?.ws).toBe(resumed.socket);
  expect(resumed.replies().map((reply) => reply.type)).toEqual(['joined']);
});
