/* @vitest-environment node */
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { WebSocket } from 'ws';
import { GameEngine } from '../../../server/core/GameEngine';
import { handleTestResetWorld } from '../../../server/testHttpHandlers';
import * as serverLogging from '../../../setup/serverLogger';

describe('test-world reset lifecycle failures', () => {
  let gameEngine: GameEngine | undefined;

  afterEach(() => {
    gameEngine?.stopGameLoop();
    gameEngine = undefined;
  });

  test('reports a live socket close failure before clearing the world', () => {
    const close = vi.fn(() => {
      throw new Error('socket close failed');
    });
    const socket = {
      CLOSED: WebSocket.CLOSED,
      close,
      readyState: WebSocket.OPEN,
    } as unknown as WebSocket;
    const engine = new GameEngine(921);
    gameEngine = engine;
    engine.addPlayer('pilot', 'Pilot', socket, { x: 0, y: 0 });

    let failure: unknown;
    try {
      engine.resetForTesting();
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(AggregateError);
    if (!(failure instanceof AggregateError)) {
      return;
    }
    expect(failure.errors).toHaveLength(1);
    expect(failure.errors[0]).toBeInstanceOf(Error);
    expect((failure.errors[0] as Error).cause).toMatchObject({ message: 'socket close failed' });
    expect(close).toHaveBeenCalledWith(1000, 'Test world reset');
    expect(engine.getPlayer('pilot')).toBeDefined();
    expect(engine.getDiagnostics().humanPlayers).toBe(1);
  });

  test('returns HTTP 500 when the reset endpoint cannot close a live socket', () => {
    const close = vi.fn(() => {
      throw new Error('socket close failed');
    });
    const socket = {
      CLOSED: WebSocket.CLOSED,
      close,
      readyState: WebSocket.OPEN,
    } as unknown as WebSocket;
    const engine = new GameEngine(922);
    gameEngine = engine;
    engine.addPlayer('pilot', 'Pilot', socket, { x: 0, y: 0 });

    const peer = new Socket();
    Object.defineProperty(peer, 'remoteAddress', { value: '127.0.0.1' });
    const req = new IncomingMessage(peer);
    req.method = 'POST';
    const res = new ServerResponse(req);
    const logError = vi.spyOn(serverLogging.logger, 'error').mockImplementation(() => undefined);

    try {
      handleTestResetWorld(req, res, 'development', engine);

      expect(res.statusCode).toBe(500);
      expect(res.writableEnded).toBe(true);
      expect(engine.getPlayer('pilot')).toBeDefined();
      expect(logError).toHaveBeenCalledWith(
        'TEST_RESET_FAILED',
        expect.objectContaining({ operation: 'reset test world' })
      );
    } finally {
      peer.destroy();
    }
  });
});
