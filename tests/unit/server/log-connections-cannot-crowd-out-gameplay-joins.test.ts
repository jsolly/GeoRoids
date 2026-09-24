/* @vitest-environment node */
import { once } from 'node:events';
import type { IncomingMessage } from 'node:http';
import { expect, test, vi } from 'vitest';
import { WebSocket } from 'ws';
import {
  CONNECTION_ADMISSION_WINDOW_MS,
  connectionLimitsDisabled,
  createConnectionAdmission,
  GAMEPLAY_CONNECTIONS_PER_WINDOW,
  LOG_CONNECTIONS_PER_WINDOW,
} from '../../../server/communication/connectionAdmission';
import { createServerInstance } from '../../../server/createServer';
import { logger } from '../../../setup/serverLogger';

test('production enables connection budgets and test runs leave them off unless enforced', () => {
  expect(LOG_CONNECTIONS_PER_WINDOW).toBe(6);
  expect(GAMEPLAY_CONNECTIONS_PER_WINDOW).toBe(50);
  expect(CONNECTION_ADMISSION_WINDOW_MS).toBe(60_000);
  expect(connectionLimitsDisabled({ nodeEnv: 'production' })).toBe(false);
  expect(connectionLimitsDisabled({ nodeEnv: 'test', vitest: 'true' })).toBe(true);
  expect(connectionLimitsDisabled({ nodeEnv: 'development' })).toBe(true);
  expect(
    connectionLimitsDisabled({ nodeEnv: 'test', vitest: 'true', enforceConnectionLimits: true })
  ).toBe(false);
});

test('a log-socket burst keeps its own budget and leaves gameplay joins open', () => {
  const admission = createConnectionAdmission(false);
  const now = 1_000_000;
  for (let index = 0; index < LOG_CONNECTIONS_PER_WINDOW; index += 1) {
    expect(admission.admit('203.0.113.8', '/logs', now).accepted).toBe(true);
  }

  const rejected = admission.admit('203.0.113.8', '/logs', now + 400);
  expect(rejected).toMatchObject({
    accepted: false,
    lane: 'logs',
    firstRejection: true,
    count: LOG_CONNECTIONS_PER_WINDOW,
    limit: LOG_CONNECTIONS_PER_WINDOW,
  });
  expect(admission.admit('203.0.113.8', '/logs', now + 800).firstRejection).toBe(false);
  expect(admission.admit('203.0.113.8', '/ws', now + 800)).toMatchObject({
    accepted: true,
    lane: 'gameplay',
  });

  expect(
    admission.admit('203.0.113.8', '/logs', now + CONNECTION_ADMISSION_WINDOW_MS).accepted
  ).toBe(false);
  expect(
    admission.admit('203.0.113.8', '/logs', now + CONNECTION_ADMISSION_WINDOW_MS + 1).accepted
  ).toBe(true);
});

test('gameplay joins and log sockets do not spend one shared connection budget', () => {
  const admission = createConnectionAdmission(false);
  const now = 5_000;
  for (let index = 0; index < GAMEPLAY_CONNECTIONS_PER_WINDOW; index += 1) {
    expect(admission.admit('203.0.113.9', '/ws', now).accepted).toBe(true);
  }
  expect(admission.admit('203.0.113.9', '/ws', now + 1).accepted).toBe(false);
  expect(admission.admit('203.0.113.9', '/logs', now + 1).accepted).toBe(true);
  expect(admission.admit('203.0.113.10', '/logs', now).accepted).toBe(true);
});

test('disabled admission accepts a log storm without touching the gameplay lane', () => {
  const admission = createConnectionAdmission(true);
  for (let index = 0; index < LOG_CONNECTIONS_PER_WINDOW + 10; index += 1) {
    expect(admission.admit('203.0.113.11', '/logs', index).accepted).toBe(true);
  }
  expect(admission.admit('203.0.113.11', '/ws', 0).accepted).toBe(true);
});

test('the running server rejects the seventh log socket and still accepts a join', async () => {
  const server = createServerInstance({
    port: 0,
    nodeEnv: 'test',
    enforceConnectionLimits: true,
  });
  const sockets: WebSocket[] = [];

  function open(port: number, path: string): Promise<'open' | number> {
    const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`);
    sockets.push(socket);
    return new Promise((resolve, reject) => {
      socket.on('error', () => undefined);
      socket.on('unexpected-response', (_request: IncomingMessage, response: IncomingMessage) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      });
      socket.on('open', () => {
        const pong = once(socket, 'pong');
        socket.ping();
        void pong.then(() => resolve('open')).catch(reject);
      });
    });
  }

  try {
    const port = await server.listening;
    const accepted = await Promise.all(
      Array.from({ length: LOG_CONNECTIONS_PER_WINDOW }, () => open(port, '/logs'))
    );
    expect(accepted.every((outcome) => outcome === 'open')).toBe(true);
    await Promise.all(
      sockets.map(
        (socket) =>
          new Promise<void>((resolve) => {
            socket.once('close', () => resolve());
            socket.close();
          })
      )
    );
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    try {
      expect(await open(port, '/logs')).toBe(429);
      expect(await open(port, '/logs')).toBe(429);
      const rateWarnings = warn.mock.calls.filter((call) =>
        String(call[0]).includes('Rate limited log connection')
      );
      expect(rateWarnings).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
    expect(await open(port, '/ws?snapshotVersion=1&asteroidInteractions=1')).toBe('open');
  } finally {
    for (const socket of sockets) {
      if (socket.readyState !== WebSocket.CLOSED) {
        socket.terminate();
      }
    }
    await server.close();
  }
});
