import { Worker } from 'node:worker_threads';
import { logger } from '../../setup/serverLogger';
import { parseDebugReportReceipt } from '../../shared/debugReports';
import type { DebugJsonValue, DebugReportReceipt } from '../../shared-types';
import type { DebugReportConfiguration } from './configuration';
import type { QueueDiagnostics } from './store';

/** The request deadline docs/agent-operations.md documents for this worker. */
const REQUEST_DEADLINE_MS = 10_000;

/** How long `close()` waits for a thread to exit before it stops waiting. */
const CLOSE_DEADLINE_MS = 2_000;

/**
 * How long a replacement waits for its predecessor's `exit`. A terminated
 * thread exits once its current SQLite call returns, so a longer wait means a
 * stuck volume, and the subsystem says so instead of promising a restart.
 */
const HANDOVER_DEADLINE_MS = 10_000;

const UNAVAILABLE_MESSAGE = 'Debug report storage is unavailable. Keep your local copy.';
const RESTARTING_MESSAGE = 'Debug report storage is restarting. Keep your local copy and retry.';
/** Published on `/health` while a retired thread will not exit; carries no path or cause. */
const STUCK_MESSAGE = 'Debug report worker has not stopped. Keep your local copy.';

/**
 * At most this many replacement threads start in any `REPLACEMENT_WINDOW_MS`.
 * Enough for a transient stall to recover more than once an hour; few enough
 * that a store that cannot open costs three short-lived threads an hour rather
 * than one per request.
 *
 * A replacement is counted when it starts and leaves the count only when the
 * window has passed. Nothing a thread does -- answering, measuring the queue,
 * dying -- touches the count, so a thread that measures once and dies cannot
 * refill it.
 */
const MAX_REPLACEMENTS = 3;
const REPLACEMENT_WINDOW_MS = 3_600_000;

/**
 * How long one fault episode may go unrecorded. The worker delivers on a 1 Hz
 * interval (`./worker` `setInterval`) and replies `fault` once per failing
 * tick, so a store that stays broken reports about 86,400 times a day. This
 * interval is what bounds the records that reach the log: about ninety-six a
 * day while the fault persists, each carrying the count it stands in for.
 *
 * It bounds the continuous case only. Identity alone bounds nothing, because a
 * store that alternates between failing and answering ends an episode and
 * opens the next one, which logs immediately -- so this interval is a floor on
 * the quiet period below, not a ceiling on the records a flapping store costs.
 */
const FAULT_LOG_INTERVAL_MS = 900_000;

/**
 * How long a store must answer without faulting before an episode is over.
 * Longer than the 1 Hz delivery interval by a wide margin, so recovery is
 * claimed on a store that has answered repeatedly rather than on one reply
 * between two failures; shorter than the logging interval above, so a genuine
 * recovery is recorded rather than collapsed into the fault it followed.
 */
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
 * `FailureCause` so the two cannot drift: a hand-written list lets an outcome
 * name a cause the episode did not actually have.
 */
type EpisodeOutcome = 'recovered' | FailureCause['kind'];

/**
 * Why reporting stopped. The player-facing message is derived from the cause
 * rather than passed beside it, so no call site can pair a message with a
 * cause that contradicts it.
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

/** One spawned thread. Its events describe live state only until it fails. */
interface ReportThread {
  readonly worker: Worker;
  /** Its failure is recorded: its replies, faults and counts are ignored. */
  failed: boolean;
  /** Settles with its exit code on `exit`, which is when its SQLite connection is gone. */
  readonly exited: Promise<number>;
}

/**
 * No SQLite, credential-bearing HTTP, parsing, or diagnostic redaction runs on
 * the game thread.
 *
 * Two different failures, deliberately: a thread-level failure -- an uncaught
 * error, an unexpected exit, or a request past its deadline -- retires that
 * thread, with its cause logged, so `/debug-reports` answers 503 and the player
 * keeps a local copy. A `fault` reply is the weaker one: the store failed to
 * answer a delivery tick, which is recorded and publishes an unknown depth, but
 * the thread is alive and submissions are still accepted, because a store that
 * cannot deliver can usually still take a report and hold it.
 *
 * A retired thread is replaced on a later request, under rules that each
 * answer a way an earlier restart broke:
 *
 * - **One thread exists at a time.** A failed thread is terminated at once, and
 *   its replacement is constructed only after its `exit`, which is when Node
 *   has closed its SQLite connection. The store is single-connection and takes
 *   an exclusive lock (`./store`), so a replacement racing its predecessor would
 *   die on arrival; and two live threads would each run a delivery interval
 *   over the same rows. `close()` therefore has exactly one thread to stop.
 * - **The replacement is single-flight.** `handover` is set in the same
 *   synchronous step that tests it, so concurrent requests -- which the HTTP
 *   layer admits -- start one replacement between them.
 * - **No request waits for a handover.** A request that finds no live thread is
 *   refused at once and the client retries. Waiting would put the predecessor's
 *   exit and the replacement's start-up inside that request's deadline, which
 *   then either answers the caller after HTTP has given up or judges a healthy
 *   replacement stalled. A request's deadline only ever judges the thread it
 *   was posted to. The handover itself is not cancelled by any deadline: a
 *   retired thread still running after `HANDOVER_DEADLINE_MS` is logged and
 *   published as stuck, refusals stop promising a restart, and the
 *   replacement already charged to the budget starts when it finally exits.
 * - **The budget refills on the clock only.** See `MAX_REPLACEMENTS`. A
 *   replacement is counted when its thread is constructed; the single-flight
 *   `handover` already stops a second request claiming a slot meanwhile, so a
 *   late handover cannot let more than `MAX_REPLACEMENTS` starts land in one
 *   window.
 *
 * A store that keeps failing therefore closes reporting until the window
 * allows another attempt, still fail-closed, rather than until the next deploy.
 */
export class DebugReportWorker {
  /**
   * The most recent thread: live, retiring, or gone. Only one is ever
   * running, because a replacement is built only after this one's `exit`.
   */
  private thread: ReportThread;
  /**
   * The replacement in progress, tested and set in one synchronous step:
   * `waiting` for the predecessor's `exit`, `overdue` once that wait has
   * outlived `HANDOVER_DEADLINE_MS`. Cleared exactly where the handover ends,
   * on that `exit`.
   */
  private handover: 'waiting' | 'overdue' | undefined;
  /** Monotonic start times of the replacements inside the budget window. */
  private replacements: number[] = [];
  /** The current run of budget refusals has been logged. */
  private exhaustionLogged = false;
  private readonly pending = new Map<number, PendingOperation>();
  private nextId = 0;
  private closing: Promise<void> | undefined;
  /** The fault being suppressed, so a broken store logs once rather than hourly. */
  private faultEpisode:
    | { suppressed: number; lastLoggedAt: number; lastFaultAt: number }
    | undefined;
  // Copied, not aliased: this field is replaced rather than written through,
  // but sharing the module constant makes one future in-place write corrupt
  // the value every other reset reads from.
  private stats: QueueDiagnostics = { ...UNMEASURED_QUEUE };
  // Retained, although it carries the Todoist credential, because a
  // replacement thread needs it. It stays on the server and is never logged.
  constructor(private readonly config: DebugReportConfiguration) {
    this.thread = this.spawn();
  }

  private spawn(): ReportThread {
    const worker = new Worker(new URL('./worker.ts', import.meta.url), {
      name: 'debug-reports',
      workerData: this.config,
      execArgv: ['--import', 'tsx'],
    });
    const exit = Promise.withResolvers<number>();
    const thread: ReportThread = { worker, failed: false, exited: exit.promise };
    // A recorded failure outranks anything the thread still sends: a
    // diagnostics message already in flight carries counts measured before the
    // failure, and letting it through would leave `/health` reading clean while
    // every submission answers 503.
    worker.on('message', (reply: ReportWorkerReply) => {
      if (!thread.failed) {
        this.receive(reply);
      }
    });
    // The errno is the whole diagnostic for this worker: it loads `tsx` and
    // opens SQLite on the mounted volume, so SQLITE_CANTOPEN or EACCES is what
    // an operator needs. Discarding the argument threw exactly that away.
    worker.on('error', (error: Error) => this.fail(thread, { kind: 'uncaught', error }));
    worker.on('exit', (code: number) => {
      if (this.closing === undefined) {
        this.fail(thread, { kind: 'exit', code });
      }
      exit.resolve(code);
    });
    return thread;
  }

  /**
   * Starts a replacement unless one is already under way or the budget is
   * spent. Returns whether a restart is worth retrying soon: not when the
   * budget is spent, and not while the retired thread has outlived its
   * handover deadline. `request()` has already refused a closing service.
   *
   * All handover state lives here, in `handover`, and ends on the
   * predecessor's `exit`.
   */
  private recover(): boolean {
    if (this.handover !== undefined) {
      return this.handover === 'waiting';
    }
    const now = globalThis.performance.now();
    this.replacements = this.replacements.filter((at) => now - at < REPLACEMENT_WINDOW_MS);
    const [oldest] = this.replacements;
    if (oldest !== undefined && this.replacements.length >= MAX_REPLACEMENTS) {
      if (!this.exhaustionLogged) {
        this.exhaustionLogged = true;
        const nextAttemptInMs = Math.ceil(oldest + REPLACEMENT_WINDOW_MS - now);
        logger.error('DEBUG_REPORTS', 'Debug report worker replacement budget is spent', {
          replacements: this.replacements.length,
          windowMs: REPLACEMENT_WINDOW_MS,
          nextAttemptInMs,
          nextAttemptAt: new Date(Date.now() + nextAttemptInMs).toISOString(),
        });
      }
      return false;
    }
    this.exhaustionLogged = false;
    logger.warn('DEBUG_REPORTS', 'Replacing the debug report worker', {
      replacement: this.replacements.length + 1,
      of: MAX_REPLACEMENTS,
      windowMs: REPLACEMENT_WINDOW_MS,
    });
    this.handover = 'waiting';
    const predecessor = this.thread;
    // `fail()` terminated the predecessor; its `exit` is when its connection
    // is gone. The deadline reports a thread stuck in a native SQLite call
    // rather than leaving every refusal promising a restart forever. It does
    // not cancel the replacement: that stays charged once and starts on the
    // late exit, so one incident costs one attempt.
    const deadline = setTimeout(() => {
      if (this.closing === undefined) {
        this.handover = 'overdue';
        logger.error(
          'DEBUG_REPORTS',
          'The previous debug report worker has not exited; reporting stays closed until it does',
          { waitedMs: HANDOVER_DEADLINE_MS }
        );
      }
    }, HANDOVER_DEADLINE_MS);
    deadline.unref();
    void predecessor.exited.then((exitCode) => {
      clearTimeout(deadline);
      const late = this.handover === 'overdue';
      this.handover = undefined;
      if (this.closing !== undefined) {
        return;
      }
      if (late) {
        // The other half of the stuck record, so an operator can see how long
        // reporting was closed and that it reopened.
        logger.warn(
          'DEBUG_REPORTS',
          'The previous debug report worker exited after the handover deadline',
          { exitCode }
        );
      }
      // Counted when it starts, so a start up to an hour after its request
      // does not leave the window early. A construction that throws still
      // spends its slot.
      this.replacements.push(globalThis.performance.now());
      try {
        this.thread = this.spawn();
      } catch (error) {
        // `new Worker` can throw. The gone predecessor stays current, which
        // is fail-closed, and a later request may try again within the budget.
        logger.error('DEBUG_REPORTS', 'Debug report worker could not be replaced', { error });
      }
    });
    return true;
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
    // Derived rather than stored, so the stuck record ends with the handover
    // and never overwrites the cause `fail()` published.
    return this.handover === 'overdue'
      ? { ...this.stats, lastError: STUCK_MESSAGE }
      : { ...this.stats };
  }
  private request(request: ReportWorkerRequest): Promise<DebugReportReceipt | null> {
    if (this.closing !== undefined) {
      return Promise.reject(new DebugReportError(503, UNAVAILABLE_MESSAGE));
    }
    const thread = this.thread;
    if (thread.failed) {
      return Promise.reject(
        new DebugReportError(503, this.recover() ? RESTARTING_MESSAGE : UNAVAILABLE_MESSAGE)
      );
    }
    if (this.pending.size >= 8) {
      return Promise.reject(
        new DebugReportError(503, 'Debug report queue is busy. Keep your local copy and retry.')
      );
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(thread, { kind: 'timeout' }), REQUEST_DEADLINE_MS);
      timer.unref();
      this.pending.set(request.requestId, { resolve, reject, timer });
      thread.worker.postMessage(request);
    });
  }
  private receive(reply: ReportWorkerReply): void {
    if (reply.type === 'diagnostics') {
      // Only a live thread's replies reach here (see `spawn()`), so a
      // measured depth from a thread that has since failed cannot erase the
      // failure `fail()` recorded.
      this.stats = reply.diagnostics;
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
   * The suppressed count is the only record of how long an episode ran, so
   * every way an episode can end has to flush it -- including the worker dying
   * mid-episode, which is the sequence an operator most wants to read.
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
   * from it, so a deadline cannot report itself as something else.
   *
   * The re-entry guard is load-bearing, not defensive. Terminating a thread
   * raises its `exit`, which comes back through here; without the guard one
   * stall emits two records that disagree, and the second overwrites the
   * `lastError` naming the timeout. It is per thread, because only one thread
   * exists at a time and each fails once.
   *
   * Every pending request belongs to this thread -- requests are posted only
   * to a live thread, and this rejects them all -- so a request's deadline can
   * never reach a successor.
   *
   * `close()` also routes through here, and only a real fault discards the last
   * measured depth, because a clean stop is not a failure and its count is
   * still true.
   */
  private fail(thread: ReportThread, cause: FailureCause): void {
    if (thread.failed) {
      return;
    }
    thread.failed = true;
    const message = FAILURE_MESSAGE[cause.kind];
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
      // Retired now, not when a replacement is wanted: a stalled thread still
      // holds the store and still runs its one-second delivery interval.
      void thread.worker.terminate();
    }
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new DebugReportError(503, message));
    }
    this.pending.clear();
  }

  /**
   * Stops the one thread that exists. A live thread is asked to close, which
   * runs its WAL checkpoint; a retiring one was terminated when it failed. Both
   * are waited for, bounded, and no replacement starts once this has begun.
   */
  close(): Promise<void> {
    if (this.closing !== undefined) {
      return this.closing;
    }
    const thread = this.thread;
    this.closing = new Promise((resolve) => {
      const deadline = setTimeout(() => {
        // Shutdown goes on without it, but a thread still in a native call is
        // joined by `process.exit`, so this is the record of why exit hangs.
        logger.error(
          'DEBUG_REPORTS',
          'The debug report worker did not stop and may hold process exit',
          { waitedMs: CLOSE_DEADLINE_MS }
        );
        void thread.worker.terminate();
        resolve();
      }, CLOSE_DEADLINE_MS);
      void thread.exited.then(() => {
        clearTimeout(deadline);
        resolve();
      });
      if (!thread.failed) {
        this.fail(thread, { kind: 'close' });
        thread.worker.postMessage({
          type: 'close',
          requestId: ++this.nextId,
        } satisfies ReportWorkerRequest);
      }
    });
    return this.closing;
  }
}
