/* @vitest-environment node */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const state = vi.hoisted(() => ({
  writes: [] as string[],
  stalled: false,
  statSize: 0,
  rm: vi.fn(async () => undefined),
  rename: vi.fn(async () => undefined),
  appendError: null as Error | null,
}));
const serverLogging = vi.hoisted(() => ({
  error: vi.fn(),
  emitExternal: vi.fn(),
}));

vi.mock('../../../setup/serverLogger', () => ({
  logger: { error: serverLogging.error },
  emitExternalLogRecord: serverLogging.emitExternal,
}));

vi.mock('node:fs', () => ({
  promises: {
    mkdir: vi.fn(async () => undefined),
    stat: vi.fn(async () => ({ size: state.statSize })),
    appendFile: vi.fn(async (_path: string, value: string) => {
      state.writes.push(value);
      if (state.appendError) {
        throw state.appendError;
      }
      if (state.stalled) {
        await new Promise(() => undefined);
      }
    }),
    rm: state.rm,
    rename: state.rename,
  },
}));

beforeEach(() => {
  vi.resetModules();
  state.writes = [];
  state.stalled = false;
  state.statSize = 0;
  state.rm.mockClear();
  state.rename.mockClear();
  state.appendError = null;
  serverLogging.error.mockClear();
  serverLogging.emitExternal.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

test('forwarded client logs accept only the bounded schema and neutralize forged lines', async () => {
  const { ClientLogger } = await import('../../../server/services/ClientLogger');
  const source = {};

  expect(
    ClientLogger.logClientMessage(
      {
        level: 'WARN',
        line: 'first\r\nforged\u001b[31m',
        message: 'first',
        sessionId: 'session\nforged',
        userAgent: 'browser\nforged',
        pageUrl: 'https://example.test/\nforged',
      },
      source
    )
  ).toBe('accepted');
  expect(await ClientLogger.flushPending()).toBe(true);
  expect(state.writes).toHaveLength(1);
  expect(state.writes[0]).not.toContain('\r');
  expect(state.writes[0]?.match(/\n/g)).toHaveLength(1);
  expect(state.writes[0]).toContain('legacy_client_log_redacted');
  expect(state.writes[0]).not.toContain('first');
  expect(state.writes[0]).toContain('legacyByteLength');
  expect(state.writes[0]).toContain('"sessionId":"session forged"');
  expect(state.writes[0]).toContain('"receivedAt"');
  expect(state.writes[0]).toContain('"receiverReleaseId"');

  expect(ClientLogger.logClientMessage({ level: 'TRACE', message: 'nope' }, {})).toBe('invalid');
  expect(
    ClientLogger.logClientMessage({ level: 'INFO', message: 'nope', arbitrary: true }, {})
  ).toBe('invalid');
  expect(ClientLogger.logClientMessage({ level: 'INFO', message: 'x'.repeat(4097) }, {})).toBe(
    'invalid'
  );
});

test('a rejected client-log append makes the completed flush fail', async () => {
  state.appendError = new Error('client disk unavailable');
  const { ClientLogger } = await import('../../../server/services/ClientLogger');
  expect(ClientLogger.logClientMessage({ level: 'ERROR', message: 'persist me' }, {})).toBe(
    'accepted'
  );
  await expect(ClientLogger.flushPending()).resolves.toBe(false);
  expect(serverLogging.error).toHaveBeenCalledExactlyOnceWith(
    'LOGGING',
    'Failed to write forwarded client log',
    { error: state.appendError }
  );
  expect(ClientLogger.getDiagnostics()).toMatchObject({
    writeErrors: 1,
    droppedRecords: 1,
    lastWriteErrorAt: expect.any(String),
  });
});

test('a flush deadline records an actionable failure before returning false', async () => {
  vi.useFakeTimers();
  state.stalled = true;
  const { ClientLogger } = await import('../../../server/services/ClientLogger');
  expect(ClientLogger.logClientMessage({ level: 'ERROR', message: 'stalled write' }, {})).toBe(
    'accepted'
  );

  const flushing = ClientLogger.flushPending(50);
  await vi.advanceTimersByTimeAsync(49);
  expect(ClientLogger.getDiagnostics().writeErrors).toBe(0);
  await vi.advanceTimersByTimeAsync(1);
  await expect(flushing).resolves.toBe(false);
  expect(ClientLogger.getDiagnostics()).toMatchObject({
    writeErrors: 1,
    droppedRecords: 0,
    lastWriteErrorAt: expect.any(String),
  });
  expect(serverLogging.error).toHaveBeenCalledWith(
    'LOGGING',
    'Failed to write forwarded client log',
    {
      error: expect.objectContaining({
        message: 'Forwarded client log flush timed out after 50 ms',
      }),
    }
  );
});

test('one socket receives a message and byte quota even when its payloads are invalid', async () => {
  const { ClientLogger } = await import('../../../server/services/ClientLogger');
  const source = {};

  for (let index = 0; index < 120; index += 1) {
    expect(ClientLogger.logClientMessage({}, source)).toBe('invalid');
  }
  expect(ClientLogger.logClientMessage({}, source)).toBe('rate-limited');

  const byteLimitedSource = {};
  const largeInvalidPayload = { arbitrary: 'x'.repeat(64_000) };
  for (let index = 0; index < 4; index += 1) {
    expect(ClientLogger.logClientMessage(largeInvalidPayload, byteLimitedSource)).toBe('invalid');
  }
  expect(ClientLogger.logClientMessage(largeInvalidPayload, byteLimitedSource)).toBe(
    'rate-limited'
  );
});

test('a stalled disk writer cannot grow the shared queue without bound', async () => {
  state.stalled = true;
  const { ClientLogger } = await import('../../../server/services/ClientLogger');
  const { emitExternalLogRecord } = await import('../../../setup/serverLogger');
  const largeStructuredLine = (level: 'info' | 'error') =>
    JSON.stringify({
      version: 1,
      timestamp: new Date().toISOString(),
      source: 'client',
      level,
      releaseId: 'test',
      message: 'x'.repeat(2048),
    });
  const outcomes = Array.from({ length: 300 }, () =>
    ClientLogger.logClientMessage({ level: 'INFO', line: largeStructuredLine('info') }, {})
  );

  expect(outcomes).toContain('accepted');
  expect(outcomes).toContain('queue-full');
  expect(serverLogging.error).toHaveBeenCalledExactlyOnceWith(
    'LOGGING',
    'Client log queue full; dropping forwarded logs',
    { droppedRecords: 1 }
  );
  const mirrorCount = vi.mocked(emitExternalLogRecord).mock.calls.length;
  expect(
    ClientLogger.logClientMessage({ level: 'ERROR', line: largeStructuredLine('error') }, {})
  ).toBe('queue-full');
  expect(emitExternalLogRecord).toHaveBeenCalledTimes(mirrorCount + 1);
  expect(await ClientLogger.flushPending(1)).toBe(false);
});

test('the client log rotates before a write would exceed its disk bound', async () => {
  state.statSize = 10 * 1024 * 1024;
  const { ClientLogger } = await import('../../../server/services/ClientLogger');

  expect(ClientLogger.logClientMessage({ level: 'INFO', message: 'after rotation' }, {})).toBe(
    'accepted'
  );
  expect(await ClientLogger.flushPending()).toBe(true);
  expect(state.rm).toHaveBeenCalledWith(expect.stringMatching(/client\.log\.1$/), { force: true });
  expect(state.rename).toHaveBeenCalledWith(
    expect.stringMatching(/client\.log$/),
    expect.stringMatching(/client\.log\.1$/)
  );
  expect(state.writes).toHaveLength(1);
});

test('accepted client loss telemetry contributes only its bounded delta to diagnostics', async () => {
  const { ClientLogger } = await import('../../../server/services/ClientLogger');
  const line = JSON.stringify({
    version: 1,
    timestamp: new Date().toISOString(),
    source: 'client',
    level: 'warn',
    releaseId: 'client-release',
    category: 'STATE',
    message: 'Client log records dropped before delivery',
    context: { droppedRecords: 9, droppedSinceLastReport: 4 },
  });

  expect(
    ClientLogger.logClientMessage({ level: 'warn', line, sessionId: 'page-session' }, {})
  ).toBe('accepted');
  expect(ClientLogger.getDiagnostics().clientReportedDroppedRecords).toBe(4);

  const forged = line.replace('"droppedSinceLastReport":4', '"droppedSinceLastReport":1000001');
  expect(
    ClientLogger.logClientMessage({ level: 'warn', line: forged, sessionId: 'page-session' }, {})
  ).toBe('accepted');
  expect(ClientLogger.getDiagnostics().clientReportedDroppedRecords).toBe(4);
});
