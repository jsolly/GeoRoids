import type {
  DebugDiagnosticSnapshot,
  DebugJsonValue,
  DebugReportReceipt,
  DebugReportSubmission,
} from '../shared-types';
import { LOG_LINE_MAX_BYTES, parseClientLogRecord } from './logRecords';
import { dropPathQueries } from './queryRedaction';

export const MAX_DEBUG_REPORT_BYTES = 2 * 1024 * 1024;
/**
 * Longest diagnostic string a report keeps, in UTF-16 code units. Real state
 * strings are a user agent or a short reason, far below this; the cap exists so
 * one string cannot carry a whole upload into redaction.
 */
const MAX_DIAGNOSTIC_TEXT = 8192;
const TRUNCATED = '…[truncated]';
/** A clip that splits a word drops at most this much of it, so no token keeps a long prefix. */
const CLIPPED_WORD_REACH = 128;
/**
 * URL parses one sanitizer call may spend; later URLs are redacted whole. Real
 * reports hold far fewer, mostly stack frames, while text built to make
 * `new URL` throw every few bytes would otherwise cost about a second per MiB.
 */
const MAX_URL_PARSES = 2048;
const STATE_KEYS = new Set([
  'version',
  'capturedAt',
  'sessionId',
  'playerId',
  'connectionId',
  'clientReleaseId',
  'serverReleaseId',
  'browser',
  'page',
  'canvas',
  'graphics',
  'audio',
  'metrics',
  'connected',
  'running',
  'ship',
  'input',
  'world',
]);
const PRIVATE_KEY =
  /(?:auth|authorization|cookie|password|secret|token|credential|privatekey|apikey|playername|nickname|displayname|chat|packet|payload|storage)/iu;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const RECEIPT_TOKEN = /^[0-9a-f]{64}$/u;
const STRUCTURAL_FIELDS = new Set([
  'capturedAt',
  'timestamp',
  'receivedAt',
  'sessionId',
  'playerId',
  'connectionId',
  'clientReleaseId',
  'serverReleaseId',
  'releaseId',
  'receiverReleaseId',
  'source',
  'level',
]);

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isWordCharacter(code: number): boolean {
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code === 95
  );
}

/**
 * Clips rather than rejects: the rest of the report is still evidence, and the
 * marker says what was cut. The result is never longer than the cap, so parsing
 * a clipped report again leaves it unchanged and its identity stays stable.
 *
 * Clipping runs before redaction, so a cut through a token would leave a prefix
 * that no longer matches its redaction rule, such as 63 characters of a 64-hex
 * secret. The clip therefore drops the kept part of a word the cut splits.
 */
function boundedText(value: string): string {
  if (value.length <= MAX_DIAGNOSTIC_TEXT) {
    return value;
  }
  let kept = MAX_DIAGNOSTIC_TEXT - TRUNCATED.length;
  if (isWordCharacter(value.charCodeAt(kept))) {
    const reach = kept - CLIPPED_WORD_REACH;
    while (kept > reach && isWordCharacter(value.charCodeAt(kept - 1))) {
      kept--;
    }
  }
  const last = value.charCodeAt(kept - 1);
  if (last >= 0xd800 && last <= 0xdbff) {
    kept--;
  }
  return `${value.slice(0, kept)}${TRUNCATED}`;
}

function jsonValue(value: unknown, depth = 0): DebugJsonValue {
  if (depth > 12) {
    throw new Error('Diagnostic nesting exceeds the report limit');
  }
  if (typeof value === 'string') {
    return boundedText(value);
  }
  if (value === null || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (Array.isArray(value) && value.length <= 1000) {
    return value.map((item) => jsonValue(item, depth + 1));
  }
  if (object(value) && Object.keys(value).length <= 128) {
    const result: { [key: string]: DebugJsonValue } = {};
    for (const [key, child] of Object.entries(value)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
        throw new Error('Invalid diagnostic key');
      }
      result[key] = jsonValue(child, depth + 1);
    }
    return result;
  }
  throw new Error('Diagnostics must contain bounded JSON values');
}

function timestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value));
}

export function parseDebugReportSubmission(input: unknown): DebugReportSubmission {
  if (
    !object(input) ||
    input['version'] !== 1 ||
    typeof input['id'] !== 'string' ||
    !UUID.test(input['id']) ||
    typeof input['receiptToken'] !== 'string' ||
    !RECEIPT_TOKEN.test(input['receiptToken']) ||
    typeof input['description'] !== 'string' ||
    !input['description'].trim() ||
    input['description'].length > 4000 ||
    !timestamp(input['submittedAt'])
  ) {
    throw new Error('Invalid debug report');
  }
  const diagnostics = input['diagnostics'];
  if (
    !object(diagnostics) ||
    !object(diagnostics['state']) ||
    !Array.isArray(diagnostics['recentLogs']) ||
    diagnostics['recentLogs'].length > 80
  ) {
    throw new Error('Invalid diagnostic snapshot');
  }
  const state: { [key: string]: DebugJsonValue } = {};
  for (const [key, value] of Object.entries(diagnostics['state'])) {
    if (!STATE_KEYS.has(key)) {
      throw new Error('Unsupported diagnostic field');
    }
    state[key] = jsonValue(value);
  }
  if (
    state['version'] !== 1 ||
    !timestamp(state['capturedAt']) ||
    typeof state['sessionId'] !== 'string' ||
    state['sessionId'].length > 128
  ) {
    throw new Error('Missing diagnostic identity');
  }
  const recentLogs: string[] = [];
  for (const line of diagnostics['recentLogs']) {
    if (
      typeof line !== 'string' ||
      new TextEncoder().encode(line).length > LOG_LINE_MAX_BYTES ||
      !parseClientLogRecord(line)
    ) {
      throw new Error('Invalid client diagnostic record');
    }
    recentLogs.push(line);
  }
  const report: DebugReportSubmission = {
    version: 1,
    id: input['id'],
    receiptToken: input['receiptToken'],
    description: input['description'],
    submittedAt: input['submittedAt'],
    diagnostics: { state, recentLogs },
  };
  if (new TextEncoder().encode(JSON.stringify(report)).length > MAX_DEBUG_REPORT_BYTES) {
    throw new Error('Debug report exceeds 2 MiB');
  }
  return report;
}

interface UrlBudget {
  remaining: number;
}

/** A clip marker is not evidence: redact the text before it, so no rule can swallow it. */
function safeText(value: string, secrets: readonly string[], urls: UrlBudget): string {
  return value.endsWith(TRUNCATED)
    ? `${redactText(value.slice(0, -TRUNCATED.length), secrets, urls)}${TRUNCATED}`
    : redactText(value, secrets, urls);
}

function redactText(value: string, secrets: readonly string[], urls: UrlBudget): string {
  // Scrub patterns first: a pilot named "http" or "Bearer" must not hide their labels.
  let text = dropPathQueries(
    value.replace(/\b(?:https?|wss?):\/\/[^\s"'<>]+/giu, (match) => {
      if (urls.remaining <= 0) {
        return '[redacted-url]';
      }
      urls.remaining--;
      try {
        const url = new URL(match);
        url.username = '';
        url.password = '';
        url.search = '';
        url.hash = '';
        return url.toString();
      } catch {
        return '[redacted-url]';
      }
    })
  )
    .replace(/\bBearer\s+\S+/giu, 'Bearer [redacted]')
    .replace(
      /\b(?:authorization|cookie|password|resumeToken|secret|token)\s*[:=]\s*[^\s,;&]+/giu,
      '[redacted]'
    )
    .replace(/\b[0-9a-f]{64}\b/giu, '[redacted]');
  for (const secret of secrets) {
    if (secret) {
      // A one-byte replacement cannot inflate a bounded log for a short pilot name.
      text = text.replaceAll(secret, '*');
    }
  }
  return text;
}

function sanitize(
  value: DebugJsonValue,
  secrets: readonly string[],
  urls: UrlBudget,
  envelope = false
): DebugJsonValue {
  if (typeof value === 'string') {
    return safeText(value, secrets, urls);
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitize(item, secrets, urls));
  }
  if (value !== null && typeof value === 'object') {
    const result: { [key: string]: DebugJsonValue } = {};
    for (const [key, child] of Object.entries(value)) {
      result[key] =
        PRIVATE_KEY.test(key) || key.toLowerCase() === 'name'
          ? '[redacted]'
          : sanitize(child, envelope && STRUCTURAL_FIELDS.has(key) ? [] : secrets, urls);
    }
    return result;
  }
  return value;
}

/** Clone before opening UI, and redact text as well as sensitive field names. */
export function sanitizeDebugDiagnostics(
  snapshot: DebugDiagnosticSnapshot,
  secrets: readonly string[] = []
): DebugDiagnosticSnapshot {
  const urls: UrlBudget = { remaining: MAX_URL_PARSES };
  const state: { [key: string]: DebugJsonValue } = {};
  for (const [key, value] of Object.entries(snapshot.state)) {
    state[key] = sanitize(value, STRUCTURAL_FIELDS.has(key) ? [] : secrets, urls);
  }
  return {
    state,
    recentLogs: snapshot.recentLogs.map((line) => {
      const parsed: unknown = JSON.parse(line);
      return JSON.stringify(sanitize(jsonValue(parsed), secrets, urls, true));
    }),
  };
}

export function formatDebugDiagnostics(snapshot: DebugDiagnosticSnapshot): string {
  return `GeoRoids diagnostics\n${JSON.stringify(snapshot.state, null, 2)}\nRecent client logs (up to 80, oldest first):\n${snapshot.recentLogs.join('\n')}`;
}

export function parseDebugReportReceipt(input: unknown): DebugReportReceipt {
  if (
    !object(input) ||
    typeof input['id'] !== 'string' ||
    !UUID.test(input['id']) ||
    (input['state'] !== 'pending' && input['state'] !== 'delivered' && input['state'] !== 'blocked')
  ) {
    throw new Error('Invalid report receipt');
  }
  return { id: input['id'], state: input['state'] };
}
