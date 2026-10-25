import { Worker } from 'node:worker_threads';
import { logger } from '../../setup/serverLogger';
import { parseDebugReportReceipt } from '../../shared/debugReports';
import type { DebugJsonValue, DebugReportReceipt } from '../../shared-types';
import type { DebugReportConfiguration } from './configuration';
import type { QueueDiagnostics } from './store';

/** Enough for a transient stall to recover; few enough that a corrupt store cannot spin. */
export const MAX_WORKER_RESTARTS = 3;

/** The request deadline docs/agent-operations.md documents for this worker. */
const REQUEST_DEADLINE_MS = 10_000;

/**
 * The queue before anything has measured it. Null is not zero: a fresh process
 * and a store that failed to answer both have an unknown depth, and publishing
 * zero would tell an operator the queue is drained.
 *
 * `QueueDiagnostics` is owned by `./store`, but this value cannot live there:
 * importing a value from that module would pull SQLite onto the game thread,
 * which this file exists to prevent.
 */
const UNMEASURED_QUEUE: QueueDiagnostics = {
  pending: null,
  blocked: null,
  oldestPendingAt: null,
  lastError: null,
};

/**
 * Why reporting stopped. The player-facing message follows from the cause
 * rather than travelling beside it, so a caller cannot pair the two wrongly --
 * the timeout path used to pass its own message and still log "worker failed"
 * with a fabricated `exitCode: undefined`.
 */
type FailureCause =
  | { kind: 'uncaught'; error: Error }
  | { kind: 'exit'; code: number }
  | { kind: 'timeout' }
  | { kind: 'close' };

const FAILURE_MESSAGE: Record<FailureCause['kind'], string> = {
  uncaught: 'Debug report worker is unavailable. Keep your local copy.',
  exit: 'Debug report worker stopped. Keep your local copy.',
  timeout: 'Debug report storage timed out. Keep your local copy and retry later.',
  close: 'Debug report storage is closing.',
};

/** The errno or exit code is the whole diagnostic; the kind names the rest. */
function failureContext(cause: Exclude<FailureCause, { kind: 'close' }>): Record<string, unknown> {
  if (cause.kind === 'uncaught') {
    // It loads `tsx` and opens SQLite on the mounted volume, so
    // SQLITE_CANTOPEN or EACCES is what an operator needs.
    return { error: cause.error };
  }
  if (cause.kind === 'exit') {
    return { exitCode: cause.code };
  }
  return { deadlineMs: REQUEST_DEADLINE_MS };
}

export class DebugReportError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}
export type ReportWorkerRequest =
  | { type: 'enqueue'; requestId: number; body: string; address: string; health: DebugJsonValue }
  | { type: 'status'; requestId: number; id: string; receiptToken: string }
  | { type: 'close'; requestId: number };
export type ReportWorkerReply =
  | { type: 'result'; requestId: number; receipt: DebugReportReceipt | null }
  | { type: 'error'; requestId: number; status: number; message: string }
  | { type: 'diagnostics'; diagnostics: QueueDiagnostics }
  /** Cause of a storage failure, logged on the game thread and never published. */
  | { type: 'fault'; detail: string }
  | { type: 'closed'; requestId: number };
interface PendingOperation {
  resolve: (value: DebugReportReceipt | null) => void;
  reject: (error: DebugReportError) => void;
  timer: NodeJS.Timeout;
}

/** No SQLite, credential-bearing HTTP, parsing, or diagnostic redaction runs on the game thread. */
export class DebugReportWorker {
  // Not readonly: a bounded restart replaces it after a fault.
  private worker: Worker;
  private readonly pending = new Map<number, PendingOperation>();
  private nextId = 0;
  private failed = false;
  private restarts = 0;
  /** Identifies the live thread so a replaced one's late events are ignored. */
  private generation = 0;
  private closing: Promise<void> | undefined;
  /** The fault being suppressed, so a broken store logs once rather than hourly. */
  private faultEpisode: { detail: string; suppressed: number } | undefined;
  private stats: QueueDiagnostics = UNMEASURED_QUEUE;
  constructor(private readonly config: DebugReportConfiguration) {
    this.worker = this.spawn();
  }

  private spawn(): Worker {
    // Only the live thread's events describe live state. A replaced worker
    // still emits `exit` after its own fault, and without this its successor
    // would be marked failed and the request that restarted it rejected.
    const generation = ++this.generation;
    const live = (): boolean => this.generation === generation;
    const worker = new Worker(new URL('./worker.ts', import.meta.url), {
      name: 'debug-reports',
      workerData: this.config,
      execArgv: ['--import', 'tsx'],
    });
    worker.on('message', (reply: ReportWorkerReply) => {
      if (live()) {
        this.receive(reply);
      }
    });
    // The errno is the whole diagnostic for this worker: it loads `tsx` and
    // opens SQLite on the mounted volume, so SQLITE_CANTOPEN or EACCES is what
    // an operator needs. Discarding the argument threw exactly that away.
    worker.on('error', (error: Error) => {
      if (live()) {
        this.fail({ kind: 'uncaught', error });
      }
    });
    worker.on('exit', (code: number) => {
      if (live() && !this.closing) {
        this.fail({ kind: 'exit', code });
      }
    });
    return worker;
  }

  /**
   * A fault used to be terminal: nothing cleared `failed` and nothing replaced
   * the worker, so one ten-second stall ended reporting until the process did,
   * while the refusal told the player to retry later. A later request now gets
   * a fresh worker, a bounded number of times — enough that a transient SQLite
   * stall recovers, few enough that a corrupt store cannot spin.
   */
  private restart(): void {
    this.restarts += 1;
    logger.warn('DEBUG_REPORTS', 'Restarting the debug report worker', {
      attempt: this.restarts,
      of: MAX_WORKER_RESTARTS,
    });
    this.failed = false;
    // The depth is unknown until the new thread measures it, but the failure
    // that forced this restart still happened and is still the most recent
    // thing known about the subsystem. Clearing it would undo the guard in
    // `receive()`, whose whole purpose is to stop a recorded failure being
    // erased; the new thread's first measured reply replaces it.
    this.stats = { ...UNMEASURED_QUEUE, lastError: this.stats.lastError };
    this.worker = this.spawn();
  }
  enqueue(body: string, address: string, health: DebugJsonValue): Promise<DebugReportReceipt> {
    return this.request({ type: 'enqueue', requestId: ++this.nextId, body, address, health }).then(
      (receipt) => {
        if (!receipt) {
          throw new DebugReportError(503, 'Report was not acknowledged. Keep your local copy.');
        }
        return receipt;
      }
    );
  }
  status(id: string, receiptToken: string): Promise<DebugReportReceipt | null> {
    return this.request({ type: 'status', requestId: ++this.nextId, id, receiptToken });
  }
  diagnostics(): QueueDiagnostics {
    return { ...this.stats };
  }
  private request(request: ReportWorkerRequest): Promise<DebugReportReceipt | null> {
    if (this.failed && this.closing === undefined && this.restarts < MAX_WORKER_RESTARTS) {
      this.restart();
    }
    if (this.failed || this.closing !== undefined) {
      return Promise.reject(
        new DebugReportError(503, 'Debug report storage is unavailable. Keep your local copy.')
      );
    }
    if (this.pending.size >= 8) {
      return Promise.reject(
        new DebugReportError(503, 'Debug report queue is busy. Keep your local copy and retry.')
      );
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fail({ kind: 'timeout' });
        void this.worker.terminate();
      }, REQUEST_DEADLINE_MS);
      timer.unref();
      this.pending.set(request.requestId, { resolve, reject, timer });
      this.worker.postMessage(request);
    });
  }
  private receive(reply: ReportWorkerReply): void {
    if (reply.type === 'diagnostics') {
      // A recorded failure outranks the worker's own counts. `fail()` owns
      // `lastError`, and for a fault it has already marked the depth unknown;
      // a diagnostics reply still in flight carries counts measured before
      // that failure, so letting it through would erase the record and leave
      // `/health` reading clean while every submission answers 503.
      if (!this.failed) {
        this.stats = reply.diagnostics;
      }
      // A measured depth proves the store answered, so any fault episode has
      // ended. The fault's own companion reply carries null counts, so it
      // cannot end the episode it just opened.
      if (reply.diagnostics.pending !== null) {
        this.endFaultEpisode();
      }
      return;
    }
    if (reply.type === 'fault') {
      this.recordFault(reply.detail);
      return;
    }
    const pending = this.pending.get(reply.requestId);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(reply.requestId);
    if (reply.type === 'error') {
      pending.reject(new DebugReportError(reply.status, reply.message));
    } else if (reply.type === 'closed') {
      pending.resolve(null);
    } else {
      try {
        pending.resolve(reply.receipt === null ? null : parseDebugReportReceipt(reply.receipt));
      } catch {
        pending.reject(new DebugReportError(503, 'Invalid report storage acknowledgement.'));
      }
    }
  }
  /**
   * A broken store throws on every delivery tick, so the worker faults once a
   * second for as long as it stays broken. Logging each one wrote roughly
   * 86,400 stack traces a day into stdout and the rotating log: it rotated away
   * every other diagnostic from the same incident and pushed the log writer
   * into dropping other components' records, so one failing subsystem took out
   * the evidence for all of them at exactly the wrong moment. One episode now
   * costs one line, plus one when its cause changes or it ends.
   */
  private recordFault(detail: string): void {
    const episode = this.faultEpisode;
    if (episode?.detail === detail) {
      episode.suppressed += 1;
      return;
    }
    if (episode) {
      this.endFaultEpisode();
    }
    this.faultEpisode = { detail, suppressed: 0 };
    // The detail travels as structured context, like the sibling call in
    // `fail()`, rather than interpolated into the message, so a stack cannot
    // break the message's own bounding.
    logger.error('DEBUG_REPORTS', 'Debug report storage failed', { detail });
  }

  private endFaultEpisode(): void {
    const episode = this.faultEpisode;
    if (!episode) {
      return;
    }
    this.faultEpisode = undefined;
    logger.warn('DEBUG_REPORTS', 'Debug report storage stopped faulting', {
      suppressedFaults: episode.suppressed,
    });
  }

  /**
   * One failure, one record. The cause is typed because the message follows
   * from it: passing both separately let the ten-second timeout report itself
   * as "worker failed" with `exitCode: undefined`, naming neither the timeout
   * nor a real exit code.
   *
   * The re-entry guard is load-bearing, not defensive. The timeout path calls
   * `terminate()`, and that raises `exit` on the same generation, which used to
   * come back through here and emit a second, contradictory line for one stall.
   * An operator reading the log for a stalled queue got two records that
   * disagreed, neither mentioning a timeout.
   *
   * `close()` also routes through here, and only a real fault discards the last
   * measured depth: treating a clean stop as a failure logged an ERROR on every
   * shutdown and threw away a count that was still true.
   */
  private fail(cause: FailureCause): void {
    const message = FAILURE_MESSAGE[cause.kind];
    if (this.failed) {
      return;
    }
    this.failed = true;
    if (cause.kind === 'close') {
      this.stats = { ...this.stats, lastError: message };
    } else {
      // Replaced rather than written through: `this.stats` can be the
      // diagnostics message the thread last sent, and a failure must not reach
      // back into it.
      this.stats = { ...UNMEASURED_QUEUE, lastError: message };
      logger.error('DEBUG_REPORTS', message, failureContext(cause));
    }
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new DebugReportError(503, message));
    }
    this.pending.clear();
  }
  close(): Promise<void> {
    if (this.closing !== undefined) {
      return this.closing;
    }
    this.closing = new Promise((resolve) => {
      this.fail({ kind: 'close' });
      let settled = false;
      const finish = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(deadline);
        resolve();
      };
      const deadline = setTimeout(() => {
        void this.worker.terminate();
        finish();
      }, 2_000);
      this.worker.once('exit', finish);
      this.worker.postMessage({
        type: 'close',
        requestId: ++this.nextId,
      } satisfies ReportWorkerRequest);
    });
    return this.closing;
  }
}
