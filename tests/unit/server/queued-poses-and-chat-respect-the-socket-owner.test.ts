/* @vitest-environment node */

import { performance as nodePerformance } from 'node:perf_hooks';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { WebSocketCore } from '../../../server/communication/WebSocketCore';
import { GameEngine } from '../../../server/core/GameEngine';
import { logger } from '../../../setup/serverLogger';
import { GAME_TICK_MS, MAX_CATCH_UP_TICKS } from '../../../shared/gameClock';
import { PLAYER_MOTION } from '../../../shared/playerMotion';
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

test('repeated enhanced-motion rejects stay within one bounded socket summary', () => {
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
    suppressed: 1,
  });
});
test('a pose outside the movement envelope logs which check failed and by how much', () => {
  const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  const { socket } = join('enhanced-pilot');
  const pilot = engine.getPlayer('enhanced-pilot');
  if (!pilot) {
    throw new Error('Expected the enhanced pilot to join');
  }
  // Half a second of silence earns 30 frames on top of the 9-frame lead; a
  // jump of 60 frames overshoots that budget the way a stalled client would.
  const speed = engine.playerMotion.maximumTravelSpeed(pilot, engine.getServerTime());
  const earnedCredit = speed * (PLAYER_MOTION.poseLeadFrames + 30);
  const jump = speed * 60;
  advanceElapsed(500);
  core.handleClientMessage(
    {
      type: 'update',
      id: 'enhanced-pilot',
      data: {
        position: { x: pilot.position.x + jump, y: pilot.position.y },
        velocity: { x: 0, y: 0 },
        angle: 0,
        thrusting: false,
        motionEpoch: 1,
        motionSequence: 0,
      },
    },
    socket
  );
  const rejected = warn.mock.calls.filter(
    ([category, event]) => category === 'STATE' && event === 'motion_command_rejected'
  );
  expect(rejected).toHaveLength(1);
  const logged = rejected[0]?.[2] as
    | { envelope?: { displacement: number; credit: number } }
    | undefined;
  expect(logged).toMatchObject({
    reason: 'Enhanced movement exceeds its server-time envelope',
    motionMode: 'handoff',
    envelope: { check: 'displacement', mode: 'free', elapsedMs: 500, velocity: 0 },
  });
  if (!logged?.envelope) {
    throw new Error('Expected envelope diagnostics in the rejection log');
  }
  expect(logged.envelope.displacement).toBeCloseTo(jump, 6);
  expect(logged.envelope.credit).toBeCloseTo(earnedCredit, 6);
});

test('a pose credited a blocked server second lands where the pilot flew and is logged once', () => {
  const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  const { socket } = join('enhanced-pilot');
  const pilot = engine.getPlayer('enhanced-pilot');
  if (!pilot) {
    throw new Error('Expected the enhanced pilot to join');
  }
  for (const rock of engine.getAllAsteroids()) {
    engine.removeAsteroid(rock.id);
  }
  expect(engine.stepClock()).toBe(0);
  const speed = engine.playerMotion.legalSpeed(pilot, engine.getServerTime());
  const start = { ...pilot.position };
  const cruise = (sequence: number, frames: number) => ({
    type: 'update',
    id: 'enhanced-pilot',
    data: {
      position: { x: start.x + speed * frames, y: start.y },
      velocity: { x: speed, y: 0 },
      angle: 0,
      thrusting: true,
      motionEpoch: 1,
      motionSequence: sequence,
    },
  });
  const creditLogs = () =>
    warn.mock.calls.filter(
      ([category, event]) => category === 'STATE' && event === 'motion_blocked_time_credited'
    );
  const rejections = () =>
    warn.mock.calls.filter(
      ([category, event]) => category === 'STATE' && event === 'motion_command_rejected'
    );

  // The loop is blocked for 1.6 s while the pilot cruises on; the first report
  // read afterwards is 80 frames out, past the 69 the old cap allowed.
  monotonicNowMs += 1_600;
  expect(engine.stepClock()).toBe(MAX_CATCH_UP_TICKS);
  core.handleClientMessage(cruise(0, 80), socket);
  expect(rejections()).toEqual([]);
  expect(pilot.position.x).toBeCloseTo(start.x + speed * 80, 6);
  expect(creditLogs()).toHaveLength(1);
  const logged = creditLogs()[0]?.[2] as { blockedMs: number } | undefined;
  expect(logged).toMatchObject({
    playerId: 'enhanced-pilot',
    receivedAt: 10_000,
    gameTime: MAX_CATCH_UP_TICKS,
    receivedSequence: 0,
  });
  expect(logged?.blockedMs).toBeCloseTo(1_600 - GAME_TICK_MS, 3);

  // The rest of the drained burst carries no blocked credit and logs nothing more.
  core.handleClientMessage(cruise(1, 81), socket);
  expect(rejections()).toEqual([]);
  expect(creditLogs()).toHaveLength(1);

  // A block shorter than the one-second cap needs no credit and is not logged.
  monotonicNowMs += 900;
  expect(engine.stepClock()).toBe(54);
  core.handleClientMessage(cruise(2, 81 + 50), socket);
  expect(rejections()).toEqual([]);
  expect(creditLogs()).toHaveLength(1);
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
