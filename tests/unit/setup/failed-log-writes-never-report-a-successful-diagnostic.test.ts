/* @vitest-environment node */
import type { Writable } from 'node:stream';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const state = vi.hoisted(() => ({
  callbacks: [] as Array<(error?: Error | null) => void>,
  failure: null as Error | null,
  manualWrites: false,
  stalled: false,
  streams: [] as Writable[],
  chunks: [] as string[],
  statSize: 0,
  rm: vi.fn(async () => undefined),
  rename: vi.fn(async () => undefined),
}));
vi.mock('node:fs', async () => {
  const { Writable } = await import('node:stream');
  return {
    default: {
      createWriteStream: () => {
        const stream = new Writable({
          write(_chunk, _encoding, callback) {
            state.chunks.push(String(_chunk));
            if (state.manualWrites) {
              state.callbacks.push(callback);
              return;
            }
            if (!state.stalled) {
              callback(state.failure);
            }
          },
        });
        state.streams.push(stream);
        return stream;
      },
    },
    promises: {
      mkdir: vi.fn(async () => undefined),
      stat: vi.fn(async () => ({ size: state.statSize })),
      rm: state.rm,
      rename: state.rename,
    },
  };
});

beforeEach(() => {
  vi.resetModules();
  state.callbacks = [];
  state.failure = null;
  state.manualWrites = false;
  state.stalled = false;
  state.chunks = [];
  state.statSize = 0;
  state.rm.mockClear();
  state.rename.mockClear();
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
});
afterEach(() => {
  for (const stream of state.streams.splice(0)) {
    stream.destroy();
  }
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

test('debug request logs preserve useful headers while redacting proxy and API credentials in both sinks', async () => {
  vi.stubEnv('SERVER_LOG_LEVEL', 'debug');
  const { flushServerLogs, logger } = await import('../../../setup/serverLogger');
  logger.debug('HTTP request', {
    headers: {
      'x-api-key': 'private-api-value',
      'proxy-authorization': 'Basic private-proxy-value',
      authorization: 'Bearer private-bearer-value',
      'content-type': 'application/json',
    },
  });
  await expect(flushServerLogs()).resolves.toBe(true);
  const fileRecord = JSON.parse(state.chunks[0] ?? 'null');
  expect(fileRecord.context.headers).toEqual({
    'x-api-key': '[redacted]',
    'proxy-authorization': '[redacted]',
    authorization: '[redacted]',
    'content-type': 'application/json',
  });
  expect(process.stdout.write).toHaveBeenCalledWith(state.chunks[0]);
  expect(state.chunks.join('')).not.toContain('private-');
});

test('a failed file append returns failure and includes the cause in the local error signal', async () => {
  state.failure = new Error('disk unavailable');
  const { getServerLogDiagnostics, writeServerDiagnostic } = await import(
    '../../../setup/serverLogger'
  );
  await expect(writeServerDiagnostic('diagnostic')).resolves.toBe(false);
  expect(process.stdout.write).toHaveBeenCalledWith(expect.stringContaining('disk unavailable'));
  expect(getServerLogDiagnostics().writeErrors).toBe(1);
  expect(getServerLogDiagnostics().droppedRecords).toBe(1);
});

test('a synchronous stdout failure persists its original cause without writing the fallback to stdout', async () => {
  const brokenPipe = Object.assign(new Error('stdout pipe closed'), { code: 'EPIPE' });
  vi.mocked(process.stdout.write).mockImplementation(() => {
    throw brokenPipe;
  });
  const { flushServerLogs, getServerLogDiagnostics, logger } = await import(
    '../../../setup/serverLogger'
  );
  const errorsBefore = getServerLogDiagnostics().stdoutWriteErrors;

  logger.error('STATE', 'stdout_failure_probe', { playerId: 'pilot-stdout' });
  await expect(flushServerLogs()).resolves.toBe(true);

  const records = state.chunks.map((chunk) => JSON.parse(chunk));
  expect(records).toContainEqual(
    expect.objectContaining({
      source: 'server',
      level: 'error',
      category: 'LOGGING',
      message: 'stdout_write_failed',
      context: expect.objectContaining({
        operation: 'write structured server log to stdout',
        errorCode: 'EPIPE',
        cause: expect.objectContaining({ errorName: 'Error', message: 'stdout pipe closed' }),
      }),
    })
  );
  expect(records.filter((record) => record.message === 'stdout_write_failed')).toHaveLength(1);
  expect(process.stdout.write).toHaveBeenCalledOnce();
  expect(getServerLogDiagnostics().stdoutWriteErrors).toBe(errorsBefore + 1);
});

test('asynchronous stdout errors retain one cause record per outage while counting every error', async () => {
  const { flushServerLogs, getServerLogDiagnostics, logger } = await import(
    '../../../setup/serverLogger'
  );
  logger.info('stdout recovery probe');
  await expect(flushServerLogs()).resolves.toBe(true);
  state.chunks = [];
  const errorsBefore = getServerLogDiagnostics().stdoutWriteErrors;

  process.stdout.emit('error', Object.assign(new Error('async stdout EPIPE'), { code: 'EPIPE' }));
  process.stdout.emit('error', Object.assign(new Error('same stdout outage'), { code: 'EPIPE' }));
  await expect(flushServerLogs()).resolves.toBe(true);

  const records = state.chunks.map((chunk) => JSON.parse(chunk));
  expect(records.filter((record) => record.message === 'stdout_write_failed')).toHaveLength(1);
  expect(records[0]).toMatchObject({
    category: 'LOGGING',
    message: 'stdout_write_failed',
    context: {
      operation: 'write structured server log to stdout',
      errorCode: 'EPIPE',
      cause: { errorName: 'Error', message: 'async stdout EPIPE' },
    },
  });
  expect(getServerLogDiagnostics().stdoutWriteErrors).toBe(errorsBefore + 2);
});

test('a failed stdout fallback cannot recurse when the server log is also unavailable', async () => {
  const { flushServerLogs, getServerLogDiagnostics, logger } = await import(
    '../../../setup/serverLogger'
  );
  logger.info('stdout recovered before combined failure');
  await expect(flushServerLogs()).resolves.toBe(true);
  state.chunks = [];
  vi.mocked(process.stdout.write).mockClear();
  state.failure = new Error('server log disk unavailable');
  vi.mocked(process.stdout.write).mockImplementation(() => {
    throw Object.assign(new Error('stdout unavailable'), { code: 'EPIPE' });
  });
  const stdoutErrorsBefore = getServerLogDiagnostics().stdoutWriteErrors;

  logger.error('STATE', 'combined_logging_failure_probe');
  await expect(flushServerLogs()).resolves.toBe(false);
  await new Promise<void>((resolve) => setImmediate(resolve));

  const attemptedRecords = state.chunks.map((chunk) => JSON.parse(chunk));
  expect(
    attemptedRecords.filter((record) => record.message === 'stdout_write_failed')
  ).toHaveLength(1);
  expect(process.stdout.write).toHaveBeenCalledOnce();
  expect(getServerLogDiagnostics().stdoutWriteErrors).toBe(stdoutErrorsBefore + 1);
});

test('a stalled file cannot leave a diagnostic request or shutdown flush pending forever', async () => {
  vi.useFakeTimers();
  state.stalled = true;
  const { writeServerDiagnostic, flushServerLogs } = await import('../../../setup/serverLogger');
  const writing = writeServerDiagnostic('diagnostic');
  await vi.advanceTimersByTimeAsync(1000);
  await expect(writing).resolves.toBe(false);
  expect(process.stdout.write).toHaveBeenCalledWith(
    expect.stringContaining('Timed out writing server diagnostic')
  );
  const flushing = flushServerLogs(50);
  await vi.advanceTimersByTimeAsync(50);
  await expect(flushing).resolves.toBe(false);
  expect(process.stdout.write).toHaveBeenCalledWith(
    expect.stringContaining('Timed out flushing server logs')
  );
});

test('concurrent diagnostic requests each observe their own completed file write', async () => {
  state.manualWrites = true;
  const { writeServerDiagnostic } = await import('../../../setup/serverLogger');
  const first = writeServerDiagnostic('first');
  const second = writeServerDiagnostic('second');

  await vi.waitFor(() => expect(state.callbacks).toHaveLength(1));
  state.callbacks.shift()?.();
  await expect(first).resolves.toBe(true);

  await vi.waitFor(() => expect(state.callbacks).toHaveLength(1));
  state.callbacks.shift()?.(new Error('second write failed'));
  await expect(second).resolves.toBe(false);
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(process.stdout.write).toHaveBeenCalledWith(expect.stringContaining('second write failed'));
});

test('queued server records freeze state at the logging call', async () => {
  state.manualWrites = true;
  const { logger } = await import('../../../setup/serverLogger');
  const context = {
    playerId: 'pilot-1',
    authoritativeRow: { health: 75, position: { x: 10, y: 20 } },
    authToken: 'do-not-persist',
  };
  logger.info('STATE', 'damage applied', context);
  context.authoritativeRow.health = 0;
  await vi.waitFor(() => expect(state.callbacks).toHaveLength(1));
  const record = JSON.parse(state.chunks[0] ?? '{}');
  expect(record).toMatchObject({
    source: 'server',
    level: 'info',
    category: 'STATE',
    playerId: 'pilot-1',
    context: {
      authoritativeRow: { health: 75, position: { x: 10, y: 20 } },
      authToken: '[redacted]',
    },
  });
  state.callbacks.shift()?.();
});

test('server.log rotates before a record would exceed its disk bound', async () => {
  state.statSize = 10 * 1024 * 1024;
  const { writeServerDiagnostic } = await import('../../../setup/serverLogger');
  await expect(writeServerDiagnostic('after rotation')).resolves.toBe(true);
  expect(state.rm).toHaveBeenCalledWith(expect.stringMatching(/server\.log\.1$/), { force: true });
  expect(state.rename).toHaveBeenCalledWith(
    expect.stringMatching(/server\.log$/),
    expect.stringMatching(/server\.log\.1$/)
  );
});

test('a stalled server log cannot grow its pending file queue without bound', async () => {
  state.stalled = true;
  const { getServerLogDiagnostics, logger } = await import('../../../setup/serverLogger');
  for (let index = 0; index < 1000; index++) {
    logger.info('STATE', 'bounded queue', { index, detail: 'x'.repeat(4096) });
  }
  expect(getServerLogDiagnostics()).toMatchObject({
    droppedRecords: expect.any(Number),
    writeErrors: expect.any(Number),
    stdoutDroppedRecords: expect.any(Number),
    stdoutWriteErrors: expect.any(Number),
  });
  expect(getServerLogDiagnostics().droppedRecords).toBeGreaterThan(0);
  expect(getServerLogDiagnostics().queuedBytes).toBeLessThanOrEqual(256 * 1024);
});
