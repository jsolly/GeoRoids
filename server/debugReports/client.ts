import { Worker } from 'node:worker_threads';
import { logger } from '../../setup/serverLogger';
import { parseDebugReportReceipt } from '../../shared/debugReports';
import type { DebugJsonValue, DebugReportReceipt } from '../../shared-types';
import type { DebugReportConfiguration } from './configuration';
import type { QueueDiagnostics } from './store';

/** Enough for a transient stall to recover; few enough that a corrupt store cannot spin. */
export const MAX_WORKER_RESTARTS = 3;

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
  // Unknown until the worker first reports: a fresh process has not measured
  // the queue, and zero here would read as an empty one.
  private stats: QueueDiagnostics = {
    pending: null,
    blocked: null,
    oldestPendingAt: null,
    lastError: null,
  };
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
        this.fail('Debug report worker is unavailable. Keep your local copy.', { error });
      }
    });
    worker.on('exit', (code: number) => {
      if (live() && !this.closing) {
        this.fail('Debug report worker stopped. Keep your local copy.', { exitCode: code });
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
    this.stats = { pending: null, blocked: null, oldestPendingAt: null, lastError: null };
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
        this.fail('Debug report storage timed out. Keep your local copy and retry later.', {});
        void this.worker.terminate();
      }, 10_000);
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
      return;
    }
    if (reply.type === 'fault') {
      logger.error('DEBUG_REPORTS', `Debug report storage failed: ${reply.detail}`);
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
   * `fault` separates a dead worker from an ordinary shutdown. Only a fault is
   * logged and only a fault discards the last measured depth: `close()` also
   * comes through here, and treating that as a failure would log an error on
   * every clean stop and throw away a still-valid count.
   */
  private fail(message: string, fault?: { error?: Error; exitCode?: number }): void {
    this.failed = true;
    // Replaced rather than written through: `this.stats` can be the diagnostics
    // message the thread last sent, and a failure must not reach back into it.
    this.stats = fault
      ? { pending: null, blocked: null, oldestPendingAt: null, lastError: message }
      : { ...this.stats, lastError: message };
    if (fault) {
      logger.error(
        'DEBUG_REPORTS',
        fault.exitCode === undefined
          ? 'Debug report worker failed'
          : 'Debug report worker exited before close',
        fault.error ? { error: fault.error } : { exitCode: fault.exitCode }
      );
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
      this.fail('Debug report storage is closing.');
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
