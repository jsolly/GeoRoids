import { promises as fs } from 'node:fs';
import path from 'node:path';
import { emitExternalLogRecord, logger } from '../../setup/serverLogger';
import {
  createLogRecord,
  LOG_LINE_MAX_BYTES,
  parseClientLogRecord,
  stringifyLogRecord,
} from '../../shared/logRecords';
import type { DiagnosticLogRecord } from '../../shared-types';
import { SERVER_RELEASE_ID } from '../release';

const FIELDS = new Set(['level', 'line', 'message', 'sessionId', 'userAgent', 'pageUrl']);
const LEVELS = new Set(['debug', 'info', 'warn', 'error', 'DEBUG', 'INFO', 'WARN', 'ERROR']);
const WINDOW_MS = 60_000;
const MESSAGES_PER_WINDOW = 120;
const BYTES_PER_WINDOW = 256 * 1024;
const QUEUE_MAX_BYTES = 256 * 1024;
const FILE_MAX_BYTES = 10 * 1024 * 1024;
const FLUSH_TIMEOUT_MS = 1000;

type Payload = {
  level: 'debug' | 'info' | 'warn' | 'error';
  line?: string;
  message?: string;
  sessionId: string;
  userAgent?: string;
  pageUrl?: string;
};
type Quota = { startedAt: number; messages: number; bytes: number };
type QueuedLine = { value: string; bytes: number };
export type ClientLogIngressResult = 'accepted' | 'invalid' | 'rate-limited' | 'queue-full';
export type ClientLogDiagnostics = {
  accepted: number;
  invalid: number;
  rateLimited: number;
  droppedRecords: number;
  clientReportedDroppedRecords: number;
  queuedBytes: number;
  writeErrors: number;
  lastWriteErrorAt?: string;
};

const quotas = new WeakMap<object, Quota>();
const queue: QueuedLine[] = [];
let queuedBytes = 0;
let drainPromise: Promise<void> | null = null;
let fileBytes: number | null = null;
let accepted = 0;
let invalid = 0;
let rateLimited = 0;
let droppedRecords = 0;
let clientReportedDroppedRecords = 0;
let writeErrors = 0;
let lastWriteErrorAt: string | undefined;
let writeFailureSinceFlush = false;
let lastQueueWarningAt = 0;
let lastWriteWarningAt = 0;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown, maxBytes: number): string | undefined {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > maxBytes) {
    return;
  }
  return Array.from(value, (character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 31 || (code >= 127 && code <= 159) || code === 8232 || code === 8233
      ? ' '
      : character;
  }).join('');
}

function sanitize(value: unknown): Payload | undefined {
  if (!isRecord(value) || Object.keys(value).some((key) => !FIELDS.has(key))) {
    return;
  }
  const rawLevel = value['level'] ?? 'info';
  if (typeof rawLevel !== 'string' || !LEVELS.has(rawLevel)) {
    return;
  }
  const line = text(value['line'], LOG_LINE_MAX_BYTES);
  const message = text(value['message'], 4096);
  const sessionId = text(value['sessionId'] ?? 'unknown-session', 128);
  const userAgent = text(value['userAgent'], 512);
  const rawPageUrl = text(value['pageUrl'], 2048);
  let pageUrl: string | undefined;
  if (rawPageUrl) {
    try {
      const url = new URL(rawPageUrl);
      if (url.protocol === 'http:' || url.protocol === 'https:') {
        pageUrl = `${url.origin}${url.pathname}`;
      }
    } catch {
      pageUrl = undefined;
    }
  }
  if ((!line && !message) || !sessionId) {
    return;
  }
  if (value['line'] !== undefined && line === undefined) {
    return;
  }
  if (value['message'] !== undefined && message === undefined) {
    return;
  }
  if (value['userAgent'] !== undefined && userAgent === undefined) {
    return;
  }
  if (value['pageUrl'] !== undefined && rawPageUrl === undefined) {
    return;
  }
  return {
    level: rawLevel.toLowerCase() as Payload['level'],
    sessionId,
    ...(line ? { line } : {}),
    ...(message ? { message } : {}),
    ...(userAgent ? { userAgent } : {}),
    ...(pageUrl ? { pageUrl } : {}),
  };
}

function payloadBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');
  } catch {
    return BYTES_PER_WINDOW + 1;
  }
}

function withinQuota(source: object, bytes: number): boolean {
  const now = Date.now();
  let quota = quotas.get(source);
  if (!quota || now - quota.startedAt >= WINDOW_MS) {
    quota = { startedAt: now, messages: 0, bytes: 0 };
    quotas.set(source, quota);
  }
  if (quota.messages + 1 > MESSAGES_PER_WINDOW || quota.bytes + bytes > BYTES_PER_WINDOW) {
    return false;
  }
  quota.messages++;
  quota.bytes += bytes;
  return true;
}

function logPath(): string {
  return path.join(process.cwd(), 'logs', 'client.log');
}

async function size(filePath: string): Promise<number> {
  if (fileBytes !== null) {
    return fileBytes;
  }
  try {
    fileBytes = (await fs.stat(filePath)).size;
  } catch (error) {
    if (isRecord(error) && error['code'] === 'ENOENT') {
      fileBytes = 0;
    } else {
      throw error;
    }
  }
  return fileBytes;
}

async function rotate(filePath: string, nextBytes: number): Promise<void> {
  if ((await size(filePath)) + nextBytes <= FILE_MAX_BYTES) {
    return;
  }
  await fs.rm(`${filePath}.1`, { force: true });
  try {
    await fs.rename(filePath, `${filePath}.1`);
  } catch (error) {
    if (!isRecord(error) || error['code'] !== 'ENOENT') {
      throw error;
    }
  }
  fileBytes = 0;
}

function reportWriteFailure(error: unknown, recordDropped = false): void {
  writeFailureSinceFlush = true;
  writeErrors++;
  if (recordDropped) {
    droppedRecords++;
  }
  lastWriteErrorAt = new Date().toISOString();
  if (Date.now() - lastWriteWarningAt < WINDOW_MS) {
    return;
  }
  lastWriteWarningAt = Date.now();
  logger.warn('LOGGING', 'Failed to write forwarded client log', { error });
}

async function drain(): Promise<void> {
  const filePath = logPath();
  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
  } catch (error) {
    reportWriteFailure(error);
  }
  while (queue.length > 0) {
    const line = queue.shift();
    if (!line) {
      continue;
    }
    try {
      await rotate(filePath, line.bytes);
      await fs.appendFile(filePath, line.value, 'utf8');
      fileBytes = (fileBytes ?? 0) + line.bytes;
    } catch (error) {
      reportWriteFailure(error, true);
    } finally {
      queuedBytes -= line.bytes;
    }
  }
}

function startDrain(): void {
  if (drainPromise) {
    return;
  }
  const current = drain().catch(reportWriteFailure);
  drainPromise = current;
  void current.finally(() => {
    if (drainPromise === current) {
      drainPromise = null;
    }
    if (queue.length > 0) {
      startDrain();
    }
  });
}

function receivedRecord(payload: Payload): DiagnosticLogRecord {
  const parsed = payload.line ? parseClientLogRecord(payload.line) : undefined;
  const receivedAt = new Date().toISOString();
  const legacyText = payload.line ?? payload.message ?? '';
  const base =
    parsed ??
    createLogRecord({
      timestamp: receivedAt,
      source: 'client',
      level: payload.level,
      releaseId: 'unknown',
      category: 'LEGACY_CLIENT',
      message: 'legacy_client_log_redacted',
      context: { legacyByteLength: Buffer.byteLength(legacyText, 'utf8') },
    });
  return createLogRecord({
    ...base,
    source: 'client',
    sessionId: payload.sessionId,
    receivedAt,
    receiverReleaseId: SERVER_RELEASE_ID,
    context: {
      ...base.context,
      ...(payload.userAgent ? { userAgent: payload.userAgent } : {}),
      ...(payload.pageUrl ? { pageUrl: payload.pageUrl } : {}),
    },
  });
}

function logClientMessage(data: unknown, source: object): ClientLogIngressResult {
  if (!withinQuota(source, payloadBytes(data))) {
    rateLimited++;
    return 'rate-limited';
  }
  const payload = sanitize(data);
  if (!payload) {
    invalid++;
    return 'invalid';
  }
  const record = receivedRecord(payload);
  if (
    record.category === 'STATE' &&
    record.message === 'Client log records dropped before delivery' &&
    typeof record.context?.['droppedSinceLastReport'] === 'number'
  ) {
    const reported = record.context['droppedSinceLastReport'];
    if (Number.isSafeInteger(reported) && reported > 0 && reported <= 1_000_000) {
      clientReportedDroppedRecords += reported;
    }
  }
  const value = `${stringifyLogRecord(record)}\n`;
  const bytes = Buffer.byteLength(value, 'utf8');
  if (
    record.level === 'warn' ||
    record.level === 'error' ||
    (record.level === 'info' && record.category === 'STATE')
  ) {
    emitExternalLogRecord(record);
  }
  if (queuedBytes + bytes > QUEUE_MAX_BYTES) {
    droppedRecords++;
    if (Date.now() - lastQueueWarningAt >= WINDOW_MS) {
      lastQueueWarningAt = Date.now();
      logger.warn('LOGGING', 'Client log queue full; dropping forwarded logs', { droppedRecords });
    }
    return 'queue-full';
  }
  accepted++;
  queue.push({ value, bytes });
  queuedBytes += bytes;
  startDrain();
  return 'accepted';
}

async function flushPending(timeoutMs = FLUSH_TIMEOUT_MS): Promise<boolean> {
  const boundedTimeoutMs = Number.isFinite(timeoutMs) ? Math.max(0, timeoutMs) : FLUSH_TIMEOUT_MS;
  const pending = drainPromise;
  if (!pending) {
    const succeeded = !writeFailureSinceFlush;
    writeFailureSinceFlush = false;
    return succeeded;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const completed = await Promise.race([
      pending.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), boundedTimeoutMs);
      }),
    ]);
    if (!completed) {
      reportWriteFailure(
        new Error(`Forwarded client log flush timed out after ${boundedTimeoutMs} ms`)
      );
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

function getDiagnostics(): ClientLogDiagnostics {
  return {
    accepted,
    invalid,
    rateLimited,
    droppedRecords,
    clientReportedDroppedRecords,
    queuedBytes,
    writeErrors,
    ...(lastWriteErrorAt ? { lastWriteErrorAt } : {}),
  };
}

function recordInvalidMessage(): void {
  invalid++;
}

export const ClientLogger = {
  logClientMessage,
  flushPending,
  getDiagnostics,
  recordInvalidMessage,
};
