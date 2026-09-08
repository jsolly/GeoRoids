import fs, { promises as fsPromises } from 'node:fs';
import path from 'node:path';
import { SERVER_RELEASE_ID } from '../server/release';
import { createLogRecord, stringifyLogRecord } from '../shared/logRecords';
import type { DiagnosticLogRecord } from '../shared-types';

export enum ServerLogLevel {
  ERROR = 0,
  WARN = 1,
  INFO = 2,
  DEBUG = 3,
}

export function resolveServerLogLevel(
  env: { NODE_ENV?: string; SERVER_LOG_LEVEL?: string } = {}
): ServerLogLevel {
  const explicit = (env.SERVER_LOG_LEVEL ?? process.env['SERVER_LOG_LEVEL'])?.toLowerCase();
  if (explicit === 'debug') {
    return ServerLogLevel.DEBUG;
  }
  if (explicit === 'info') {
    return ServerLogLevel.INFO;
  }
  if (explicit === 'warn') {
    return ServerLogLevel.WARN;
  }
  if (explicit === 'error') {
    return ServerLogLevel.ERROR;
  }
  const nodeEnv = env.NODE_ENV ?? process.env['NODE_ENV'];
  return nodeEnv === 'production' ? ServerLogLevel.INFO : ServerLogLevel.DEBUG;
}

const CURRENT_LOG_LEVEL = resolveServerLogLevel();
const DEFAULT_LOG_FLUSH_TIMEOUT_MS = 1000;
const SERVER_LOG_QUEUE_MAX_BYTES = 256 * 1024;
const SERVER_LOG_FILE_MAX_BYTES = 10 * 1024 * 1024;
const SERVER_STDOUT_MAX_BUFFERED_BYTES = 256 * 1024;

type StdoutLogState = {
  droppedRecords: number;
  writeErrors: number;
  lastWriteErrorAt?: string;
  listenerInstalled?: boolean;
  failureReported?: boolean;
  reportFailure?: (error: unknown) => void;
};

const stdoutStateHost = globalThis as typeof globalThis & {
  __georoidsStdoutLogState?: StdoutLogState;
};
function initializeStdoutLogState(): StdoutLogState {
  const existing = stdoutStateHost.__georoidsStdoutLogState;
  if (existing) {
    return existing;
  }
  const created: StdoutLogState = { droppedRecords: 0, writeErrors: 0 };
  stdoutStateHost.__georoidsStdoutLogState = created;
  return created;
}
const stdoutLogState = initializeStdoutLogState();
if (!stdoutLogState.listenerInstalled) {
  stdoutLogState.listenerInstalled = true;
  process.stdout.on('error', (error) => {
    stdoutLogState.reportFailure?.(error);
  });
}

let serverLogStream: fs.WriteStream | null = null;
let isLogDirReady = false;
let serverLogBytes: number | null = null;
let pendingFileWrites: Promise<void> = Promise.resolve();
let queuedFileBytes = 0;
let droppedFileRecords = 0;
let fileWriteErrors = 0;
let writeFailureSinceFlush = false;
let lastWriteErrorAt: string | undefined;
const reportedFileFailures = new Set<string>();
const countedFileErrors = new WeakSet<object>();
const fileErrorsWithoutStdout = new WeakSet<object>();

export type ServerLogDiagnostics = {
  queuedBytes: number;
  droppedRecords: number;
  writeErrors: number;
  lastWriteErrorAt?: string;
  stdoutDroppedRecords: number;
  stdoutWriteErrors: number;
  lastStdoutWriteErrorAt?: string;
};

function shouldLog(level: ServerLogLevel): boolean {
  return level <= CURRENT_LOG_LEVEL;
}

function levelName(level: ServerLogLevel): 'debug' | 'info' | 'warn' | 'error' {
  return ServerLogLevel[level].toLowerCase() as 'debug' | 'info' | 'warn' | 'error';
}

function writeStdout(line: string): void {
  if (process.stdout.writableLength > SERVER_STDOUT_MAX_BUFFERED_BYTES) {
    stdoutLogState.droppedRecords++;
    return;
  }
  try {
    process.stdout.write(`${line}\n`);
    stdoutLogState.failureReported = false;
  } catch (error) {
    reportStdoutFailure(error);
  }
}

function internalFailure(
  operation: string,
  error?: unknown,
  countWriteError = true,
  reportToStdout = true
): void {
  writeFailureSinceFlush = true;
  if (countWriteError) {
    if (typeof error === 'object' && error !== null) {
      if (countedFileErrors.has(error)) {
        return;
      }
      countedFileErrors.add(error);
    }
    fileWriteErrors++;
  }
  lastWriteErrorAt = new Date().toISOString();
  if (!reportToStdout) {
    return;
  }
  if (reportedFileFailures.has(operation)) {
    return;
  }
  reportedFileFailures.add(operation);
  const detail = error instanceof Error ? error.message : error === undefined ? '' : String(error);
  writeStdout(
    stringifyLogRecord(
      createLogRecord({
        timestamp: lastWriteErrorAt,
        source: 'server',
        level: 'error',
        releaseId: SERVER_RELEASE_ID,
        category: 'LOGGING',
        message: operation,
        ...(detail ? { context: { error: detail } } : {}),
      })
    )
  );
}

function logsDirectory(): string {
  return path.join(process.cwd(), 'logs');
}

function serverLogPath(): string {
  return path.join(logsDirectory(), 'server.log');
}

async function ensureLogDirectory(): Promise<void> {
  if (isLogDirReady) {
    return;
  }
  await fsPromises.mkdir(logsDirectory(), { recursive: true });
  isLogDirReady = true;
}

async function readServerLogSize(filePath: string): Promise<number> {
  if (serverLogBytes !== null) {
    return serverLogBytes;
  }
  try {
    serverLogBytes = (await fsPromises.stat(filePath)).size;
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      serverLogBytes = 0;
    } else {
      throw error;
    }
  }
  return serverLogBytes;
}

async function closeLogStream(): Promise<void> {
  const stream = serverLogStream;
  if (!stream) {
    return;
  }
  serverLogStream = null;
  await new Promise<void>((resolve) => stream.end(resolve));
}

async function rotateIfNeeded(filePath: string, nextBytes: number): Promise<void> {
  if ((await readServerLogSize(filePath)) + nextBytes <= SERVER_LOG_FILE_MAX_BYTES) {
    return;
  }
  await closeLogStream();
  const rotatedPath = `${filePath}.1`;
  await fsPromises.rm(rotatedPath, { force: true });
  try {
    await fsPromises.rename(filePath, rotatedPath);
  } catch (error) {
    if (
      !(typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')
    ) {
      throw error;
    }
  }
  serverLogBytes = 0;
}

async function ensureServerLogStream(): Promise<fs.WriteStream> {
  if (serverLogStream) {
    return serverLogStream;
  }
  await ensureLogDirectory();
  const stream = fs.createWriteStream(serverLogPath(), { flags: 'a', encoding: 'utf8' });
  stream.on('error', (error) => {
    internalFailure('Server log stream failed', error, true, !fileErrorsWithoutStdout.has(error));
    if (serverLogStream === stream) {
      serverLogStream = null;
    }
  });
  serverLogStream = stream;
  return stream;
}

function writeStreamLine(
  stream: fs.WriteStream,
  line: string,
  reportFailureToStdout: boolean
): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      if (!reportFailureToStdout) {
        fileErrorsWithoutStdout.add(error);
      }
      stream.off('error', onError);
      reject(error);
    };
    const onWritten = (error?: Error | null): void => {
      stream.off('error', onError);
      if (error && !reportFailureToStdout) {
        fileErrorsWithoutStdout.add(error);
      }
      error ? reject(error) : resolve();
    };
    stream.prependOnceListener('error', onError);
    try {
      stream.write(`${line}\n`, 'utf8', onWritten);
    } catch (error) {
      stream.off('error', onError);
      reject(error);
    }
  });
}

async function writeLineToFile(
  line: string,
  bytes: number,
  reportFailureToStdout: boolean
): Promise<boolean> {
  const filePath = serverLogPath();
  try {
    await ensureLogDirectory();
    await rotateIfNeeded(filePath, bytes);
    await writeStreamLine(await ensureServerLogStream(), line, reportFailureToStdout);
    serverLogBytes = (serverLogBytes ?? 0) + bytes;
    reportedFileFailures.clear();
    return true;
  } catch (error) {
    internalFailure('Server log write failed', error, true, reportFailureToStdout);
    return false;
  }
}

function queueFileLine(line: string, reportFailureToStdout = true): Promise<boolean> {
  const bytes = Buffer.byteLength(`${line}\n`, 'utf8');
  if (queuedFileBytes + bytes > SERVER_LOG_QUEUE_MAX_BYTES) {
    droppedFileRecords++;
    internalFailure(
      'Server log queue full; dropped file record',
      undefined,
      false,
      reportFailureToStdout
    );
    return Promise.resolve(false);
  }
  queuedFileBytes += bytes;
  const result = pendingFileWrites
    .then(async () => {
      const written = await writeLineToFile(line, bytes, reportFailureToStdout);
      if (!written) {
        droppedFileRecords++;
      }
      return written;
    })
    .catch((error) => {
      droppedFileRecords++;
      internalFailure('Unexpected server log failure', error, true, reportFailureToStdout);
      return false;
    })
    .finally(() => {
      queuedFileBytes -= bytes;
    });
  pendingFileWrites = result.then(() => undefined);
  return result;
}

function reportStdoutFailure(error: unknown): void {
  stdoutLogState.writeErrors++;
  stdoutLogState.lastWriteErrorAt = new Date().toISOString();
  if (stdoutLogState.failureReported) {
    return;
  }
  stdoutLogState.failureReported = true;
  const errorCode =
    typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
      ? error.code
      : undefined;
  const line = stringifyLogRecord(
    createLogRecord({
      timestamp: stdoutLogState.lastWriteErrorAt,
      source: 'server',
      level: 'error',
      releaseId: SERVER_RELEASE_ID,
      category: 'LOGGING',
      message: 'stdout_write_failed',
      context: {
        operation: 'write structured server log to stdout',
        cause: error,
        ...(errorCode ? { errorCode } : {}),
      },
    })
  );
  void queueFileLine(line, false);
}

stdoutLogState.reportFailure = reportStdoutFailure;

function splitServerArguments(
  message: string,
  args: unknown[]
): {
  category?: string;
  message: string;
  context?: unknown;
} {
  const categorized = /^[A-Z][A-Z0-9_]{1,31}$/.test(message) && typeof args[0] === 'string';
  const renderedMessage = categorized ? (args.shift() as string) : message;
  const category = categorized ? message : undefined;
  const context = args.length === 0 ? undefined : args.length === 1 ? args[0] : { arguments: args };
  return { ...(category ? { category } : {}), message: renderedMessage, context };
}

function emitServer(level: ServerLogLevel, message: string, args: unknown[]): Promise<boolean> {
  const split = splitServerArguments(message, [...args]);
  const metadata =
    split.context && typeof split.context === 'object' && !Array.isArray(split.context)
      ? (split.context as Record<string, unknown>)
      : {};
  const playerId = typeof metadata['playerId'] === 'string' ? metadata['playerId'] : undefined;
  const sessionId = typeof metadata['sessionId'] === 'string' ? metadata['sessionId'] : undefined;
  const connectionId =
    typeof metadata['connectionId'] === 'string' ? metadata['connectionId'] : undefined;
  const record = createLogRecord({
    timestamp: new Date().toISOString(),
    source: 'server',
    level: levelName(level),
    releaseId: SERVER_RELEASE_ID,
    ...split,
    ...(playerId ? { playerId } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(connectionId ? { connectionId } : {}),
  });
  const line = stringifyLogRecord(record);
  writeStdout(line);
  return queueFileLine(line);
}

/** Mirror an already-normalized client record to stdout without duplicating it in server.log. */
export function emitExternalLogRecord(record: DiagnosticLogRecord): void {
  writeStdout(stringifyLogRecord(record));
}

export function getServerLogDiagnostics(): ServerLogDiagnostics {
  return {
    queuedBytes: queuedFileBytes,
    droppedRecords: droppedFileRecords,
    writeErrors: fileWriteErrors,
    ...(lastWriteErrorAt ? { lastWriteErrorAt } : {}),
    stdoutDroppedRecords: stdoutLogState.droppedRecords,
    stdoutWriteErrors: stdoutLogState.writeErrors,
    ...(stdoutLogState.lastWriteErrorAt
      ? { lastStdoutWriteErrorAt: stdoutLogState.lastWriteErrorAt }
      : {}),
  };
}

export async function writeServerDiagnostic(message: string): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      emitServer(ServerLogLevel.INFO, message, []),
      new Promise<boolean>((resolve) => {
        timeout = setTimeout(() => {
          internalFailure('Timed out writing server diagnostic');
          resolve(false);
        }, DEFAULT_LOG_FLUSH_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

export async function flushServerLogs(timeoutMs = DEFAULT_LOG_FLUSH_TIMEOUT_MS): Promise<boolean> {
  const bounded = Number.isFinite(timeoutMs)
    ? Math.max(0, timeoutMs)
    : DEFAULT_LOG_FLUSH_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const completed = await Promise.race([
      pendingFileWrites.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), bounded);
      }),
    ]);
    if (!completed) {
      internalFailure('Timed out flushing server logs');
      return false;
    }
    const succeeded = !writeFailureSinceFlush;
    writeFailureSinceFlush = false;
    return succeeded;
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

export const logger = {
  debug: (message: string, ...args: unknown[]): void => {
    if (shouldLog(ServerLogLevel.DEBUG)) {
      void emitServer(ServerLogLevel.DEBUG, message, args);
    }
  },
  info: (message: string, ...args: unknown[]): void => {
    if (shouldLog(ServerLogLevel.INFO)) {
      void emitServer(ServerLogLevel.INFO, message, args);
    }
  },
  warn: (message: string, ...args: unknown[]): void => {
    if (shouldLog(ServerLogLevel.WARN)) {
      void emitServer(ServerLogLevel.WARN, message, args);
    }
  },
  error: (message: string, ...args: unknown[]): void => {
    if (shouldLog(ServerLogLevel.ERROR)) {
      void emitServer(ServerLogLevel.ERROR, message, args);
    }
  },
};

export const currentLogLevel = CURRENT_LOG_LEVEL;
