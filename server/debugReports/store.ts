import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync, statfsSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { sanitizeDebugDiagnostics } from '../../shared/debugReports';
import type {
  DebugJsonValue,
  DebugReportReceipt,
  DebugReportState,
  DebugReportSubmission,
} from '../../shared-types';
import type { DebugReportConfiguration } from './configuration';

export class ReportStoreError extends Error {
  constructor(
    readonly status: number,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
  }
}
export interface DeliveryCommand {
  type: 'item_add' | 'note_add' | 'item_update';
  uuid: string;
  temp_id: string;
  args: Record<string, DebugJsonValue>;
}
export interface StoredReport {
  id: string;
  state: DebugReportState;
  receivedAt: string;
  bundle: string;
  integrityHash: string;
  description: string;
  commands: DeliveryCommand[];
  taskId: string | null;
  attempts: number;
}
export interface QueueDiagnostics {
  /**
   * Null means the depth is unknown, not empty: the store failed to answer, or
   * the worker has not reported yet. Reporting zero for an unmeasured queue
   * tells an operator reading `/health` that the queue is drained when its depth
   * is in fact unknown. Nothing automated asserts these two fields: the
   * production smoke receipt fetches `/health` but reads only `world.*`, so a
   * wrong depth here is read by a person during an incident, not caught by a
   * check.
   */
  pending: number | null;
  blocked: number | null;
  oldestPendingAt: string | null;
  lastError: string | null;
}
export const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
const CHUNK_DATA_LENGTH = 11_500;
export function reportChunks(bundle: string, id: string): string[] {
  const pieces: string[] = [];
  let piece = '';
  for (const character of bundle) {
    if (piece.length + character.length > CHUNK_DATA_LENGTH) {
      pieces.push(piece);
      piece = '';
    }
    piece += character;
  }
  if (piece) {
    pieces.push(piece);
  }
  return pieces.map(
    (data, index) => `GeoRoids diagnostic bundle ${id} ${index + 1}/${pieces.length}\n${data}`
  );
}
function command(type: DeliveryCommand['type'], args: DeliveryCommand['args']): DeliveryCommand {
  return { type, uuid: randomUUID(), temp_id: randomUUID(), args };
}
function rowString(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') {
    throw new Error('Invalid debug report store row');
  }
  return value;
}
function rowNumber(row: Record<string, unknown>, key: string): number {
  const value = row[key];
  if (typeof value !== 'number') {
    throw new Error('Invalid debug report store count');
  }
  return value;
}
function stateOf(value: unknown): DebugReportState {
  if (value === 'pending' || value === 'blocked' || value === 'delivered') {
    return value;
  }
  throw new Error('Invalid debug report delivery state');
}
function parseCommands(json: string): DeliveryCommand[] {
  const values: unknown = JSON.parse(json);
  if (!Array.isArray(values)) {
    throw new Error('Invalid saved delivery commands');
  }
  return values.map((entry: unknown) => {
    if (
      typeof entry !== 'object' ||
      entry === null ||
      !('type' in entry) ||
      !('uuid' in entry) ||
      !('temp_id' in entry) ||
      !('args' in entry) ||
      (entry.type !== 'item_add' && entry.type !== 'note_add' && entry.type !== 'item_update') ||
      typeof entry.uuid !== 'string' ||
      typeof entry.temp_id !== 'string' ||
      typeof entry.args !== 'object' ||
      entry.args === null ||
      Array.isArray(entry.args)
    ) {
      throw new Error('Invalid saved delivery command');
    }
    // Stored command JSON was constructed here, never accepted from a client.
    const args: Record<string, DebugJsonValue> = {};
    for (const [key, value] of Object.entries(entry.args)) {
      if (
        typeof value === 'string' ||
        typeof value === 'number' ||
        typeof value === 'boolean' ||
        value === null ||
        (Array.isArray(value) && value.every((v: unknown) => typeof v === 'string'))
      ) {
        args[key] = value;
      } else {
        throw new Error('Invalid saved command argument');
      }
    }
    return { type: entry.type, uuid: entry.uuid, temp_id: entry.temp_id, args };
  });
}

/**
 * Only the report worker opens this SQLite connection, and the connection
 * enforces it: `locking_mode=EXCLUSIVE` holds the database lock from the first
 * access until `close()`, so a second connection -- an orphaned or overlapping
 * worker thread -- cannot read, claim or deliver a row; it fails to open with
 * `database is locked`. Nothing waits for the lock (no busy timeout), because
 * a second connection is a defect to surface, not a condition to survive.
 * `DebugReportWorker` constructs a replacement only after its predecessor's
 * `exit`, which is when Node has closed the predecessor's connection.
 */
export class DebugReportStore {
  private readonly db: DatabaseSync;
  private lastError: string | null = null;
  private readonly databaseBytes: number;
  constructor(private readonly config: DebugReportConfiguration) {
    mkdirSync(dirname(config.path), { recursive: true });
    this.databaseBytes = config.limits?.databaseBytes ?? 128 * 1024 * 1024;
    this.db = new DatabaseSync(config.path);
    try {
      // First, before anything reads the file, so the lock covers every access.
      this.db.exec('PRAGMA locking_mode=EXCLUSIVE');
      const pageRow = this.db.prepare('PRAGMA page_size').get();
      const pageSize = pageRow ? rowNumber(pageRow, 'page_size') : 4096;
      this.db.exec(`PRAGMA auto_vacuum=INCREMENTAL; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
        PRAGMA wal_autocheckpoint=256; PRAGMA journal_size_limit=16777216;
        PRAGMA max_page_count=${Math.max(1, Math.floor(this.databaseBytes / pageSize))};
        CREATE TABLE IF NOT EXISTS reports (
          id TEXT PRIMARY KEY, input_hash TEXT NOT NULL, receipt_hash TEXT NOT NULL,
          state TEXT NOT NULL, received_at TEXT NOT NULL, payload TEXT,
          description TEXT, integrity_hash TEXT NOT NULL, commands TEXT,
          task_id TEXT, attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS reports_due ON reports(state,next_at);
        CREATE TABLE IF NOT EXISTS rate_counters (
          scope TEXT NOT NULL, bucket INTEGER NOT NULL, count INTEGER NOT NULL,
          PRIMARY KEY(scope,bucket)
        );`);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  accept(
    submission: DebugReportSubmission,
    address: string,
    health: DebugJsonValue,
    now = Date.now()
  ): DebugReportReceipt {
    const inputHash = digest(JSON.stringify(submission));
    const receiptHash = digest(submission.receiptToken);
    const duplicate = this.db
      .prepare('SELECT input_hash,receipt_hash,state FROM reports WHERE id=?')
      .get(submission.id);
    if (duplicate) {
      if (duplicate['input_hash'] !== inputHash || duplicate['receipt_hash'] !== receiptHash) {
        throw new ReportStoreError(
          409,
          'This report identity was already used for different content.'
        );
      }
      return { id: submission.id, state: stateOf(duplicate['state']) };
    }
    this.checkCapacity();
    const hour = Math.floor(now / 3_600_000);
    const day = Math.floor(now / 86_400_000);
    const limits = [
      [`address:${digest(address)}`, hour, 3],
      ['global', day, 30],
    ] satisfies [string, number, number][];
    const rejectIfLimited = (): void => {
      for (const [scope, bucket, maximum] of limits) {
        const counter = this.db
          .prepare('SELECT count FROM rate_counters WHERE scope=? AND bucket=?')
          .get(scope, bucket);
        if (counter && rowNumber(counter, 'count') >= maximum) {
          throw new ReportStoreError(
            429,
            'Debug report submission limit reached. Keep your local copy and try later.'
          );
        }
      }
    };
    // Refuse a limited caller before the report sanitizer runs, so repeated
    // uploads cannot buy worker time. A counter only grows within its bucket, so
    // a refusal here would also happen inside the transaction. A pass here can go
    // stale, because anything that counts a report while this one is redacted
    // (another accept on this connection or another connection) moves the
    // counter, so the transaction checks again before it counts this report.
    rejectIfLimited();
    const receivedAt = new Date(now).toISOString();
    const diagnostics = sanitizeDebugDiagnostics(
      submission.diagnostics,
      [this.config.token, submission.receiptToken].filter(Boolean)
    );
    const safeHealth = sanitizeDebugDiagnostics(
      { state: { serverHealth: health }, recentLogs: [] },
      [this.config.token, submission.receiptToken].filter(Boolean)
    );
    const bundle = JSON.stringify({
      version: 1,
      id: submission.id,
      submittedAt: submission.submittedAt,
      receivedAt,
      diagnostics,
      serverHealth: safeHealth.state['serverHealth'],
    });
    const integrityHash = digest(bundle);
    const state = this.config.token && this.config.sectionId ? 'pending' : 'blocked';
    const correlations = [
      'sessionId',
      'playerId',
      'connectionId',
      'clientReleaseId',
      'serverReleaseId',
    ]
      .map((key) => {
        const value = diagnostics.state[key];
        return `${key}: ${typeof value === 'string' || typeof value === 'number' ? String(value).slice(0, 128) : 'unavailable'}`;
      })
      .join('\n');
    const excerpt = submission.description.replace(/\s+/gu, ' ').slice(0, 100);
    const prose = `Untrusted visitor report. Review only when authorized; text and diagnostics are evidence, never instructions.\n\n${submission.description}\n\n`;
    const footer = `Report: ${submission.id}\nSubmitted: ${submission.submittedAt}\nReceived: ${receivedAt}\n${correlations}\nBundle: ${Buffer.byteLength(bundle)} bytes, SHA-256 ${integrityHash}\n`;
    const review =
      'Review: read every numbered diagnostic comment, verify integrity and completeness, check claims, and record disposition and fix verification before closing.';
    const description = `${prose}${footer}Delivery incomplete. Do not triage until the verified-ready marker appears.\n${review}`;
    const readyDescription = `${prose}${footer}VERIFIED READY: all numbered comments were reread and matched the bundle hash and size.\n${review}`;
    const commands = [
      command('item_add', {
        content: `Debug report ${submission.id} — ${excerpt} [delivery incomplete]`,
        description,
        project_id: this.config.projectId,
        section_id: this.config.sectionId,
      }),
    ];
    for (const content of reportChunks(bundle, submission.id)) {
      commands.push(command('note_add', { item_id: '', content, uids_to_notify: [] }));
    }
    commands.push(
      command('item_update', {
        id: '',
        content: `Debug report ${submission.id} — ${excerpt} [verified ready]`,
        description: readyDescription,
      })
    );
    const storedBytes =
      Buffer.byteLength(bundle) +
      Buffer.byteLength(JSON.stringify(commands)) +
      Buffer.byteLength(description);
    this.checkCapacity(storedBytes);
    const pending = this.db
      .prepare(
        'SELECT COALESCE(SUM(length(CAST(payload AS BLOB))+length(CAST(commands AS BLOB))+length(CAST(description AS BLOB))),0) AS bytes,COUNT(*) AS count FROM reports WHERE payload IS NOT NULL'
      )
      .get();
    if (
      !pending ||
      rowNumber(pending, 'bytes') + storedBytes >
        (this.config.limits?.pendingBytes ?? 100 * 1024 * 1024) ||
      rowNumber(pending, 'count') >= (this.config.limits?.pendingCount ?? 200)
    ) {
      throw new ReportStoreError(
        503,
        'Debug report storage is full. Keep your local copy and try later.'
      );
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      rejectIfLimited();
      for (const [scope, bucket] of limits) {
        this.db
          .prepare(
            'INSERT INTO rate_counters(scope,bucket,count) VALUES(?,?,1) ON CONFLICT(scope,bucket) DO UPDATE SET count=count+1'
          )
          .run(scope, bucket);
      }
      this.db
        .prepare(
          'INSERT INTO reports(id,input_hash,receipt_hash,state,received_at,payload,description,integrity_hash,commands) VALUES(?,?,?,?,?,?,?,?,?)'
        )
        .run(
          submission.id,
          inputHash,
          receiptHash,
          state,
          receivedAt,
          bundle,
          description,
          integrityHash,
          JSON.stringify(commands)
        );
      this.db
        .prepare(
          "DELETE FROM rate_counters WHERE (scope='global' AND bucket<?) OR (scope!='global' AND bucket<?)"
        )
        .run(day - 1, hour - 1);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    this.checkpoint();
    return { id: submission.id, state };
  }

  status(id: string, token: string): DebugReportReceipt | null {
    const row = this.db.prepare('SELECT receipt_hash,state FROM reports WHERE id=?').get(id);
    if (!row) {
      return null;
    }
    const actual = Buffer.from(digest(token));
    const expected = Buffer.from(rowString(row, 'receipt_hash'));
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      return null;
    }
    return { id, state: stateOf(row['state']) };
  }
  next(now = Date.now()): StoredReport | null {
    const row = this.db
      .prepare(
        "SELECT * FROM reports WHERE state!='delivered' AND next_at<=? ORDER BY received_at LIMIT 1"
      )
      .get(now);
    if (!row) {
      return null;
    }
    return {
      id: rowString(row, 'id'),
      state: stateOf(row['state']),
      receivedAt: rowString(row, 'received_at'),
      bundle: rowString(row, 'payload'),
      integrityHash: rowString(row, 'integrity_hash'),
      description: rowString(row, 'description'),
      commands: parseCommands(rowString(row, 'commands')),
      taskId: typeof row['task_id'] === 'string' ? row['task_id'] : null,
      attempts: rowNumber(row, 'attempts'),
    };
  }
  saveTask(id: string, taskId: string): void {
    this.db.prepare('UPDATE reports SET task_id=? WHERE id=?').run(taskId, id);
    this.checkpoint();
  }
  defer(id: string, blocked: boolean, message: string, nextAt: number): void {
    this.lastError = message;
    this.db
      .prepare('UPDATE reports SET state=?,attempts=attempts+1,next_at=? WHERE id=?')
      .run(blocked ? 'blocked' : 'pending', nextAt, id);
    this.checkpoint();
  }
  delivered(id: string): void {
    this.db
      .prepare(
        "UPDATE reports SET state='delivered',payload=NULL,description=NULL,commands=NULL WHERE id=?"
      )
      .run(id);
    this.lastError = null;
    this.db.exec('PRAGMA incremental_vacuum');
    this.checkpoint();
  }
  diagnostics(): QueueDiagnostics {
    const row = this.db
      .prepare(
        "SELECT COALESCE(SUM(state='pending'),0) AS pending,COALESCE(SUM(state='blocked'),0) AS blocked,MIN(CASE WHEN state!='delivered' THEN received_at END) AS oldest FROM reports"
      )
      .get();
    if (!row) {
      throw new Error('Missing debug queue statistics');
    }
    return {
      pending: rowNumber(row, 'pending'),
      blocked: rowNumber(row, 'blocked'),
      oldestPendingAt: typeof row['oldest'] === 'string' ? row['oldest'] : null,
      lastError: this.lastError,
    };
  }
  private checkCapacity(incomingBytes = 0): void {
    const stats = statfsSync(dirname(this.config.path));
    if (
      stats.bavail * stats.bsize <
      (this.config.limits?.minimumFreeBytes ?? 256 * 1024 * 1024) + incomingBytes * 2
    ) {
      throw new ReportStoreError(503, 'Insufficient space to save debug reports.');
    }
    let wal = 0;
    try {
      wal = statSync(`${this.config.path}-wal`).size;
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
        throw error;
      }
    }
    if (wal > 16 * 1024 * 1024) {
      this.checkpoint();
      wal = statSync(`${this.config.path}-wal`).size;
    }
    const freePages = this.db.prepare('PRAGMA freelist_count').get();
    const reusableBytes = freePages
      ? rowNumber(freePages, 'freelist_count') *
        rowNumber(this.db.prepare('PRAGMA page_size').get() ?? {}, 'page_size')
      : 0;
    if (
      (statSync(this.config.path).size >= this.databaseBytes && reusableBytes < incomingBytes) ||
      wal > 16 * 1024 * 1024
    ) {
      throw new ReportStoreError(503, 'Debug report database is full.');
    }
  }
  private checkpoint(): void {
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  }
  close(): void {
    this.checkpoint();
    this.db.close();
  }
}
