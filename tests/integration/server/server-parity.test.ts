// @vitest-environment node

import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { WebSocketCore } from '../../../server/communication/WebSocketCore';
import { GameEngine } from '../../../server/core/GameEngine';
import { RecordingSocket } from '../../support/recordingSocket';

describe('supported gameplay message envelopes', () => {
  let core: WebSocketCore;
  let engine: GameEngine;

  beforeEach(() => {
    engine = new GameEngine(731);
    core = new WebSocketCore(engine);
  });
  afterEach(() => {
    engine.stopGameLoop();
    core.stopPeriodicGameStateBroadcast();
  });

  test('an update without a player identity receives a timestamped error and changes no player', () => {
    const socket = new RecordingSocket();
    core.handleClientMessage({ type: 'update', data: { position: { x: 0, y: 0 } } }, socket);
    expect(socket.inbox).toEqual([
      { type: 'error', data: 'Missing player ID', timestamp: expect.any(Number) },
    ]);
    expect(core.getPlayerCount()).toBe(0);
  });
});
