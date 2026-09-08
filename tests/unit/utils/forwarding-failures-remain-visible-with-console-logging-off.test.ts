import { afterEach, expect, test, vi } from 'vitest';
import {
  createLogRecord,
  LOG_LINE_MAX_BYTES,
  parseLogRecord,
  stringifyLogRecord,
} from '../../../shared/logRecords';

const forwarding = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('../../../src/utils/logForwarder', () => ({
  startClientLogForwarder: vi.fn(),
  forwardLogToServer: forwarding.send,
}));

vi.mock('../../../src/constants', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/constants')>();
  return {
    ...actual,
    LOGGING: { ...actual.LOGGING, WRITE_TO_CONSOLE: false, FORWARD_TO_SERVER: true },
  };
});

import { setClientLogContext } from '../../../src/utils/clientLogContext';
import { logger } from '../../../src/utils/Logger';

afterEach(() => {
  vi.restoreAllMocks();
});

test('the real client logger emits correlated bounded records and redacts secrets', async () => {
  setClientLogContext({ playerId: 'pilot-7', connectionId: 'socket-3' });
  logger.warn('STATE', 'Request failed at https://game.test/play?token=secret#part', {
    playerId: 'pilot-7',
    resumeToken: 'never-write-me',
    authoritativeRow: { health: 75, position: { x: 10, y: 20 } },
    rawPacket: 'never-write-this-either',
  });
  await vi.waitFor(() => expect(forwarding.send).toHaveBeenCalled());
  const record = JSON.parse(String(forwarding.send.mock.calls.at(-1)?.[0]));
  expect(record).toMatchObject({
    version: 1,
    source: 'client',
    level: 'warn',
    category: 'STATE',
    playerId: 'pilot-7',
    connectionId: 'socket-3',
    context: {
      resumeToken: '[redacted]',
      rawPacket: '[redacted]',
      authoritativeRow: { health: 75, position: { x: 10, y: 20 } },
    },
  });
  expect(record.sessionId).toEqual(expect.any(String));
  expect(JSON.stringify(record)).not.toContain('never-write-me');
  expect(JSON.stringify(record)).not.toContain('never-write-this-either');
  expect(record.message).toBe('Request failed at https://game.test/play');
});

test('a broken forwarder emits one local failure even when ordinary console logging is disabled', async () => {
  forwarding.send.mockImplementation(() => {
    throw new Error('forwarder unavailable');
  });
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  logger.warn('TEST', 'first event');
  await vi.waitFor(() => expect(warning).toHaveBeenCalledOnce());
  logger.warn('TEST', 'second event');
  await vi.waitFor(() => expect(forwarding.send).toHaveBeenCalledTimes(2));
  expect(warning).toHaveBeenCalledOnce();
  expect(warning).toHaveBeenCalledWith(expect.stringContaining('forwarder unavailable'));
  forwarding.send.mockImplementation(() => {});
  logger.warn('TEST', 'recovered event');
  await vi.waitFor(() => expect(forwarding.send).toHaveBeenCalledTimes(3));
  await Promise.resolve();

  forwarding.send.mockImplementation(() => {
    throw new Error('second outage');
  });
  logger.warn('TEST', 'failure after recovery');
  await vi.waitFor(() => expect(warning).toHaveBeenCalledTimes(2));
  expect(warning).toHaveBeenNthCalledWith(2, expect.stringContaining('second outage'));

  forwarding.send.mockImplementation(() => {});
  logger.warn('TEST', 'final recovery');
  await vi.waitFor(() => expect(forwarding.send).toHaveBeenCalledTimes(5));
});

test('the JSONL serializer enforces its byte bound for multibyte records without losing correlation', () => {
  const line = stringifyLogRecord(
    createLogRecord({
      timestamp: new Date().toISOString(),
      source: 'client',
      level: 'warn',
      releaseId: `release-${'🛰️'.repeat(128)}`,
      category: 'STATE',
      message: '🚀'.repeat(2048),
      context: { detail: '💥'.repeat(2048) },
      sessionId: `session-${'🧭'.repeat(128)}`,
      playerId: 'pilot-7',
      connectionId: 'socket-3',
    })
  );

  expect(new TextEncoder().encode(line).byteLength).toBeLessThanOrEqual(LOG_LINE_MAX_BYTES);
  expect(parseLogRecord(line)).toMatchObject({
    source: 'client',
    level: 'warn',
    sessionId: expect.stringMatching(/^session-/),
    playerId: 'pilot-7',
    connectionId: 'socket-3',
  });
});
