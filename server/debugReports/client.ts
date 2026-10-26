import { Worker } from 'node:worker_threads';
import { logger } from '../../setup/serverLogger';
import { parseDebugReportReceipt } from '../../shared/debugReports';
import type { DebugJsonValue, DebugReportReceipt } from '../../shared-types';
import type { DebugReportConfiguration } from './configuration';
import type { QueueDiagnostics } from './store';

/** The request deadline docs/agent-operations.md documents for this worker. */
const REQUEST_DEADLINE_MS = 10_000;

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

/**
 * How a fault episode ended, so one message carries every case. Derived from
 * `FailureCause` rather than listed by hand: spelling it out separately let a
 * request timeout be reported as `worker-failed`, which is the same
 * mislabelling the typed cause was introduced to remove.
 */
type EpisodeOutcome = 'recovered' | FailureCause['kind'];

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

/**
 * No SQLite, credential-bearing HTTP, parsing, or diagnostic redaction runs on
 * the game thread.
 *
 * One thread for the life of the process.
 *
 * Two different failures, deliberately: a thread-level failure -- an uncaught
 * error, an unexpected exit, or a request past its deadline -- closes reporting
 * until the next deploy, fail-closed and with its cause logged, so
 * `/debug-reports` answers 503 and the player keeps a local copy. A `fault`
 * reply is the weaker one: the store failed to answer a delivery tick, which is
 * recorded and publishes an unknown depth, but the thread is alive and
 * submissions are still accepted, because a store that cannot deliver can
 * usually still take a report and hold it.
 *
 * Replacing a faulted thread
 * needs more than a respawn -- the store is single-connection and the HTTP
 * layer admits concurrent requests, so a replacement has to be single-flight,
 * own the thread it supersedes through shutdown, and sit outside the request
 * deadline. That belongs in its own change.
 */
export class DebugReportWorker {
  private readonly worker: Worker;
  private readonly pending = new Map<number, PendingOperation>();
  private nextId = 0;
  private failed = false;
  private closing: Promise<void> | undefined;
  /** The fault being suppressed, so a broken store logs once rather than hourly. */
  private faultEpisode:
    | { suppressed: number; lastLoggedAt: number; lastFaultAt: number }
    | undefined;
  // Copied, not aliased: this field is replaced rather than written through,
  // but sharing the module constant makes one future in-place write corrupt
  // the value every other reset reads from.
  private stats: QueueDiagnostics = { ...UNMEASURED_QUEUE };
  // The configuration is handed to the thread and not retained: it carries the
  // Todoist credential, and nothing here needs it again now that one thread
  // runs for the life of the process.
  constructor(config: DebugReportConfiguration) {
    const worker = new Worker(new URL('./worker.ts', import.meta.url), {
      name: 'debug-reports',
      workerData: config,
      execArgv: ['--import', 'tsx'],
    });
    worker.on('message', (reply: ReportWorkerReply) => this.receive(reply));
    // The errno is the whole diagnostic for this worker: it loads `tsx` and
    // opens SQLite on the mounted volume, so SQLITE_CANTOPEN or EACCES is what
    // an operator needs. Discarding the argument threw exactly that away.
    worker.on('error', (error: Error) => this.fail({ kind: 'uncaught', error }));
    worker.on('exit', (code: number) => {
      if (!this.closing) {
        this.fail({ kind: 'exit', code });
      }
    });
    this.worker = worker;
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
      // A measured depth proves the store answered, but not that an episode is
      // over: a store alternating between failing and answering produces one
      // of these between every two faults, and closing the episode on the
      // first reopened a new one on the next fault -- per-second logging
      // again, with a recovery line between each pair. Wait for it to go quiet.
      const episode = this.faultEpisode;
      if (
        reply.diagnostics.pending !== null &&
        episode &&
        globalThis.performance.now() - episode.lastFaultAt >= FAULT_QUIET_MS
      ) {
        this.endFaultEpisode('recovered');
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
   * the evidence for all of them at exactly the wrong moment.
   *
   * An episode now costs one record on its first fault and one more every
   * `FAULT_LOG_INTERVAL_MS` while it continues, each carrying the count it
   * stood in for, plus one when it ends. A store that fails continuously for a
   * day therefore costs about ninety-six records rather than 86,400.
   *
   * That is the continuous case and not a ceiling. `FAULT_QUIET_MS` is shorter
   * than the interval, so a store that answers for a minute between failures
   * ends one episode and opens another, and a new episode logs at once.
   * Bounding that as well would mean staying quiet about a store that keeps
   * breaking.
   *
   * The cause is **not**
   * part of that decision: keying on it bounded nothing, because a store that
   * alternates between two errors opens a fresh episode on every tick. A cause
   * that changes mid-episode is therefore carried in the next interval's
   * record, not logged on the spot.
   */
  private recordFault(detail: string): void {
    // Monotonic, like the rest of the server's timing: a wall-clock step
    // backwards would suppress a storage failure, and one forwards would fake
    // the quiet period that ends an episode.
    const now = globalThis.performance.now();
    const episode = this.faultEpisode;
    if (episode === undefined) {
      this.faultEpisode = { suppressed: 0, lastLoggedAt: now, lastFaultAt: now };
      // The detail travels as structured context, like the sibling call in
      // `fail()`, rather than interpolated into the message, so a stack cannot
      // break the message's own bounding.
      logger.error('DEBUG_REPORTS', 'Debug report storage failed', { detail });
      return;
    }
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
   * `terminate()`, and that raises `exit` on the same thread, which used to
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
    this.endFaultEpisode(cause.kind);
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
