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
 * How long a replacement waits for the thread it replaces to release the
 * database. Short, because the request that triggered the restart is waiting on
 * it, and a thread that will not stop is already the corrupt-store case.
 */
const WORKER_RETIRE_DEADLINE_MS = 2_000;

/**
 * How long one fault episode may go unrecorded. Identity alone bounds nothing:
 * a store that alternates between failing and answering opens a new episode on
 * every flap, which is one record per delivery tick -- the flood the collapsing
 * exists to prevent, with a recovery line added between each pair.
 */
const FAULT_LOG_INTERVAL_MS = 900_000;

/** How long a store must answer without faulting before an episode is over. */
const FAULT_QUIET_MS = 60_000;

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

/** How a fault episode ended, so one message carries every case. */
type EpisodeOutcome = 'recovered' | 'cause-changed' | 'worker-failed' | 'closed';

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
  private faultEpisode:
    | { detail: string; suppressed: number; lastLoggedAt: number; lastFaultAt: number }
    | undefined;
  // Copied, not aliased: this field is replaced rather than written through,
  // but sharing the module constant makes one future in-place write corrupt
  // the value every other reset reads from.
  private stats: QueueDiagnostics = { ...UNMEASURED_QUEUE };
  constructor(private readonly config: DebugReportConfiguration) {
    this.worker = this.spawn();
  }

  private spawn(): Worker {
    const worker = new Worker(new URL('./worker.ts', import.meta.url), {
      name: 'debug-reports',
      workerData: this.config,
      execArgv: ['--import', 'tsx'],
    });
    // Only the live thread's events describe live state. A replaced worker
    // still emits `exit` after its own fault, and without this its successor
    // would be marked failed and the request that restarted it rejected.
    //
    // Claimed after construction, not before: `new Worker` can throw, and
    // advancing the generation first would leave the thread that is still
    // running with every one of its events discarded.
    const generation = ++this.generation;
    const live = (): boolean => this.generation === generation;
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
   *
   * The outgoing thread has to be gone first. `DebugReportStore` is documented
   * as the only connection to its database and opens with no busy timeout, so
   * its bootstrap `exec` takes a write lock and throws rather than waiting. On
   * the one path that leaves a thread alive — the request deadline, which is
   * exactly what this recovery exists for — spawning straight away raced the
   * dying thread for that lock: the replacement died on arrival, the report
   * that triggered the restart was refused, and an attempt was spent without
   * the store ever being reopened. Three of those closed reporting for the
   * process, which is the outcome the restart was added to prevent.
   */
  private async restart(): Promise<void> {
    this.restarts += 1;
    logger.warn('DEBUG_REPORTS', 'Restarting the debug report worker', {
      attempt: this.restarts,
      of: MAX_WORKER_RESTARTS,
    });
    await this.retire(this.worker);
    this.failed = false;
    // A replacement inherits no fault episode. Carrying one over suppressed the
    // new thread's first storage failure as a repeat of the old thread's, so a
    // restart that failed for the same reason read as one that worked.
    this.faultEpisode = undefined;
    // The depth is unknown until the new thread measures it, but the failure
    // that forced this restart still happened and is still the most recent
    // thing known about the subsystem. Clearing it would undo the guard in
    // `receive()`, whose whole purpose is to stop a recorded failure being
    // erased; the new thread's first measured reply replaces it.
    this.stats = { ...UNMEASURED_QUEUE, lastError: this.stats.lastError };
    this.worker = this.spawn();
  }

  /** Waits for a thread to stop holding the database, bounded so a wedged one cannot block a request forever. */
  private retire(worker: Worker): Promise<void> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(deadline);
        resolve();
      };
      const deadline = setTimeout(finish, WORKER_RETIRE_DEADLINE_MS);
      deadline.unref();
      worker.once('exit', finish);
      void worker.terminate();
    });
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
      // The replacement cannot open the store until the outgoing thread lets
      // go of it, so this request waits for the handover rather than racing it.
      return this.restart().then(() => this.send(request));
    }
    return this.send(request);
  }

  private send(request: ReportWorkerRequest): Promise<DebugReportReceipt | null> {
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
      if (reply.diagnostics.pending !== null) {
        // A measured depth proves the store answered, which is the one signal
        // that a replacement actually works. Counting restarts for the life of
        // the process instead meant three stalls days apart, each of which
        // recovered fully, closed reporting permanently. A corrupt store never
        // produces a measured reply, so the anti-spin half of the bound holds.
        this.restarts = 0;
        // It does not prove an episode is over, though. A store alternating
        // between failing and answering produces one of these between every
        // two faults, and closing the episode on the first reopened a new one
        // on the next fault -- per-second logging again, now with a recovery
        // line between each pair. Wait for the store to actually go quiet.
        const episode = this.faultEpisode;
        if (episode && Date.now() - episode.lastFaultAt >= FAULT_QUIET_MS) {
          this.endFaultEpisode('recovered');
        }
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
    const now = Date.now();
    const episode = this.faultEpisode;
    if (episode === undefined) {
      this.faultEpisode = { detail, suppressed: 0, lastLoggedAt: now, lastFaultAt: now };
      // The detail travels as structured context, like the sibling call in
      // `fail()`, rather than interpolated into the message, so a stack cannot
      // break the message's own bounding.
      logger.error('DEBUG_REPORTS', 'Debug report storage failed', { detail });
      return;
    }
    episode.detail = detail;
    episode.lastFaultAt = now;
    if (now - episode.lastLoggedAt < FAULT_LOG_INTERVAL_MS) {
      episode.suppressed += 1;
      return;
    }
    // Still failing a quarter of an hour on. One more record, carrying what was
    // suppressed, so a long outage leaves a trail without flooding.
    logger.error('DEBUG_REPORTS', 'Debug report storage still failing', {
      detail,
      suppressedSince: episode.suppressed,
    });
    episode.suppressed = 0;
    episode.lastLoggedAt = now;
  }

  /**
   * The suppressed count is the only record of how long an episode ran, so it
   * has to survive every way an episode can end -- including the worker dying
   * mid-episode, which is the sequence an operator most wants to read and the
   * one that used to drop the number entirely.
   */
  private endFaultEpisode(outcome: EpisodeOutcome): void {
    const episode = this.faultEpisode;
    if (!episode) {
      return;
    }
    this.faultEpisode = undefined;
    logger.warn('DEBUG_REPORTS', 'Debug report storage fault episode ended', {
      suppressedFaults: episode.suppressed,
      outcome,
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
    // Flushed before the failure record, so the count reads in order ahead of
    // the cause rather than being abandoned with the episode.
    this.endFaultEpisode(cause.kind === 'close' ? 'closed' : 'worker-failed');
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
