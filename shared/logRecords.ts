import type { DiagnosticLogRecord } from '../shared-types';

const LOG_ENVELOPE_VERSION = 1 as const;
export const LOG_LINE_MAX_BYTES = 8192;

type StructuredLogLevel = 'debug' | 'info' | 'warn' | 'error';
type StructuredLogSource = 'client' | 'server';

const SECRET_KEYS = new Set([
  'auth',
  'authentication',
  'authorization',
  'authorizationheader',
  'proxyauthorization',
  'xapikey',
  'bearer',
  'cookie',
  'setcookie',
]);
const PRIVATE_CONTENT_KEYS = new Set([
  'botname',
  'chat',
  'chattext',
  'displayname',
  'messagetext',
  'name',
  'packet',
  'playername',
]);
const MAX_TEXT = 2048;
const MAX_CONTEXT_TEXT = 512;
const MAX_CONTEXT_KEYS = 24;
const MAX_ARRAY_ITEMS = 20;
const MAX_DEPTH = 4;

function cleanText(value: unknown, max = MAX_TEXT): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const redacted = value
    .replace(/((?:https?:\/\/[^\s?#]+|\/[a-z0-9._~!$&'()*+,;=:@%/-]+))[?#][^\s]*/gi, '$1')
    .replace(/\b(Bearer)\s+\S+/gi, '$1 [redacted]')
    .replace(
      /\b(authorization|cookie|password|resumeToken|secret|token)\s*[:=]\s*[^\s,;&]+/gi,
      '$1=[redacted]'
    );
  const cleaned = Array.from(redacted, (character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 31 || (code >= 127 && code <= 159) || code === 8232 || code === 8233
      ? ' '
      : character;
  }).join('');
  return cleaned.slice(0, max);
}

function isSensitiveKey(value: string): boolean {
  const normalized = value.replace(/[^a-z0-9]/gi, '').toLowerCase();
  return (
    SECRET_KEYS.has(normalized) ||
    /(?:credential|credentials|password|secret|token)$/.test(normalized) ||
    /^(?:apikey|privatekey)$/.test(normalized)
  );
}

function isPrivateContentKey(value: string): boolean {
  const normalized = value.replace(/[^a-z0-9]/gi, '').toLowerCase();
  return (
    PRIVATE_CONTENT_KEYS.has(normalized) ||
    normalized.startsWith('raw') ||
    normalized.endsWith('packet') ||
    normalized.endsWith('payload')
  );
}

function safeValue(
  value: unknown,
  depth: number,
  seen: WeakSet<object>
): string | number | boolean | null | unknown[] | Record<string, unknown> {
  if (value === null || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : String(value);
  }
  if (typeof value === 'string') {
    return cleanText(value, MAX_CONTEXT_TEXT) ?? '';
  }
  if (typeof value === 'bigint' || typeof value === 'symbol' || typeof value === 'function') {
    return String(value).slice(0, MAX_CONTEXT_TEXT);
  }
  if (typeof value !== 'object') {
    return String(value).slice(0, MAX_CONTEXT_TEXT);
  }
  if (value instanceof Error) {
    return {
      errorName: cleanText(value.name, 128) ?? 'Error',
      message: cleanText(value.message) ?? '',
      ...(value.stack ? { stack: cleanText(value.stack) } : {}),
    };
  }
  if (seen.has(value)) {
    return '[circular]';
  }
  if (depth >= MAX_DEPTH) {
    return '[depth-limit]';
  }
  seen.add(value);
  if (Array.isArray(value)) {
    const result = value.slice(0, MAX_ARRAY_ITEMS).map((item) => safeValue(item, depth + 1, seen));
    seen.delete(value);
    return result;
  }
  const result: Record<string, unknown> = {};
  for (const [rawKey, child] of Object.entries(value).slice(0, MAX_CONTEXT_KEYS)) {
    const key = cleanText(rawKey, 128);
    if (!key) {
      continue;
    }
    result[key] =
      isSensitiveKey(key) || isPrivateContentKey(key)
        ? '[redacted]'
        : safeValue(child, depth + 1, seen);
  }
  seen.delete(value);
  return result;
}

function detachLogContext(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) {
    return undefined;
  }
  const detached = safeValue(value, 0, new WeakSet());
  return Array.isArray(detached)
    ? { values: detached }
    : typeof detached === 'object' && detached
      ? detached
      : { value: detached };
}

function cleanId(value: unknown): string | undefined {
  const cleaned = cleanText(value, 128);
  return cleaned ? cleaned : undefined;
}

export function createLogRecord(input: {
  timestamp: string;
  source: StructuredLogSource;
  level: StructuredLogLevel;
  releaseId: string;
  message: string;
  category?: string;
  context?: unknown;
  sessionId?: string;
  playerId?: string;
  connectionId?: string;
  receivedAt?: string;
  receiverReleaseId?: string;
}): DiagnosticLogRecord {
  const context = detachLogContext(input.context);
  const sessionId = cleanId(input.sessionId);
  const playerId = cleanId(input.playerId);
  const connectionId = cleanId(input.connectionId);
  const receiverReleaseId = cleanId(input.receiverReleaseId);
  return {
    version: LOG_ENVELOPE_VERSION,
    timestamp: cleanText(input.timestamp, 64) ?? new Date(0).toISOString(),
    source: input.source,
    level: input.level,
    releaseId: cleanId(input.releaseId) ?? 'unknown',
    message: cleanText(input.message) ?? '',
    ...(input.category ? { category: cleanText(input.category, 64) ?? '' } : {}),
    ...(context && Object.keys(context).length > 0 ? { context } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(playerId ? { playerId } : {}),
    ...(connectionId ? { connectionId } : {}),
    ...(input.receivedAt ? { receivedAt: cleanText(input.receivedAt, 64) ?? '' } : {}),
    ...(receiverReleaseId ? { receiverReleaseId } : {}),
  };
}

export function parseLogRecord(line: string): DiagnosticLogRecord | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const receivedAt =
    typeof record['receivedAt'] === 'string' && Number.isFinite(Date.parse(record['receivedAt']))
      ? record['receivedAt']
      : undefined;
  if (
    record['version'] !== LOG_ENVELOPE_VERSION ||
    !['client', 'server'].includes(String(record['source'])) ||
    !['debug', 'info', 'warn', 'error'].includes(String(record['level'])) ||
    typeof record['timestamp'] !== 'string' ||
    !Number.isFinite(Date.parse(record['timestamp'])) ||
    typeof record['message'] !== 'string'
  ) {
    return undefined;
  }
  return createLogRecord({
    timestamp: record['timestamp'],
    source: record['source'] as StructuredLogSource,
    level: record['level'] as StructuredLogLevel,
    releaseId: typeof record['releaseId'] === 'string' ? record['releaseId'] : 'unknown',
    message: record['message'],
    ...(typeof record['category'] === 'string' ? { category: record['category'] } : {}),
    ...('context' in record ? { context: record['context'] } : {}),
    ...(typeof record['sessionId'] === 'string' ? { sessionId: record['sessionId'] } : {}),
    ...(typeof record['playerId'] === 'string' ? { playerId: record['playerId'] } : {}),
    ...(typeof record['connectionId'] === 'string' ? { connectionId: record['connectionId'] } : {}),
    ...(receivedAt ? { receivedAt } : {}),
    ...(typeof record['receiverReleaseId'] === 'string'
      ? { receiverReleaseId: record['receiverReleaseId'] }
      : {}),
  });
}

export function parseClientLogRecord(line: string): DiagnosticLogRecord | undefined {
  const record = parseLogRecord(line);
  return record?.source === 'client' ? record : undefined;
}

function truncateUtf8(value: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  let result = '';
  let bytes = 0;
  for (const character of value) {
    const characterBytes = encoder.encode(character).byteLength;
    if (bytes + characterBytes > maxBytes) {
      break;
    }
    result += character;
    bytes += characterBytes;
  }
  return result;
}

export function stringifyLogRecord(envelope: DiagnosticLogRecord): string {
  const rendered = JSON.stringify(envelope);
  if (new TextEncoder().encode(rendered).byteLength <= LOG_LINE_MAX_BYTES) {
    return rendered;
  }
  return JSON.stringify({
    ...envelope,
    message: truncateUtf8(envelope.message, 1024),
    context: { truncated: true },
  });
}
