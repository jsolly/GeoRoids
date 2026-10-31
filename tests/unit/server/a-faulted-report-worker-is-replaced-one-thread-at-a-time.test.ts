/* @vitest-environment node */
import { afterEach, expect, test, vi } from 'vitest';
import {
  DebugReportError,
  DebugReportWorker,
  type ReportWorkerReply,
  type ReportWorkerRequest,
} from '../../../server/debugReports/client';

/** One spawned thread: what the client sent it, and whether it has gone. */
interface FakeThread {
  sent: ReportWorkerRequest[];
  listeners: Map<string, ((value: never) => void)[]>;
  terminated: number;
  exited: boolean;
  /** How many other threads had not exited when this one was constructed. */
  coexisting: number;
}

const threads = vi.hoisted(() => ({
  all: [] as FakeThread[],
  /**
   * While set, `terminate()` leaves the `exit` to the test: a thread that has
   * been told to stop but has not yet released the store.
   */
  holdExits: false,
  /** Constructions still to refuse, as `new Worker` does when it cannot start a thread. */
  refuseConstructions: 0,
}));
const serverLogging = vi.hoisted(() => ({ error: vi.fn(), warn: vi.fn() }));

vi.mock('../../../setup/serverLogger', () => ({
  logger: { error: serverLogging.error, warn: serverLogging.warn },
}));

/** Node raises `exit` once per thread, after its environment is torn down. */
function exitThread(thread: FakeThread, code: number): void {
  if (thread.exited) {
    return;
  }
  thread.exited = true;
  for (const handler of thread.listeners.get('exit') ?? []) {
    (handler as (code: number) => void)(code);
  }
}

// The thread is the external boundary. The fake supplies transport, failure
// events and `exit`, never a decision about replacing a thread; those rules
// belong to the client under test.
vi.mock('node:worker_threads', () => ({
  Worker: class {
    private readonly thread: FakeThread;
    constructor() {
      if (threads.refuseConstructions > 0) {
        threads.refuseConstructions -= 1;
        throw new Error('ERR_WORKER_INIT_FAILED: thread could not start');
      }
      this.thread = {
        sent: [],
        listeners: new Map(),
        terminated: 0,
        exited: false,
        coexisting: threads.all.filter((other) => !other.exited).length,
      };
      threads.all.push(this.thread);
    }
    on(event: string, handler: (value: never) => void): void {
      const attached = this.thread.listeners.get(event) ?? [];
      attached.push(handler);
      this.thread.listeners.set(event, attached);
    }
    postMessage(request: ReportWorkerRequest): void {
      this.thread.sent.push(request);
    }
    terminate(): Promise<number> {
      this.thread.terminated += 1;
      // A double that never emitted `exit` after `terminate()` would let a
      // missing handover pass: the replacement would simply never appear.
      if (!threads.holdExits) {
        queueMicrotask(() => exitThread(this.thread, 1));
      }
      return Promise.resolve(1);
    }
  },
}));

const CONFIG = {
  path: '/data/debug-reports.sqlite',
  token: 'delivery-token',
  projectId: 'project-replacement',
  sectionId: 'section-replacement',
};
const RECEIPT_ID = '00000000-0000-4000-8000-000000000000';
const RECEIPT_TOKEN = 'a'.repeat(64);
const RESTARTING = 'Debug report storage is restarting. Keep your local copy and retry.';
const UNAVAILABLE = 'Debug report storage is unavailable. Keep your local copy.';
const MEASURED = {
  pending: 0,
  blocked: 0,
  oldestPendingAt: null,
  lastError: null,
} as const;

const workers: DebugReportWorker[] = [];
afterEach(async () => {
  vi.useRealTimers();
  const closing = workers.splice(0).map((worker) => worker.close());
  threads.holdExits = false;
  threads.refuseConstructions = 0;
  for (const thread of threads.all) {
    exitThread(thread, 0);
  }
  await Promise.all(closing);
  threads.all = [];
  vi.useRealTimers();
  vi.clearAllMocks();
});

function start(): DebugReportWorker {
  const worker = new DebugReportWorker(CONFIG);
  workers.push(worker);
  return worker;
}
function threadAt(index: number): FakeThread {
  const thread = threads.all[index];
  if (!thread) {
    throw new Error(`Thread ${index} was never constructed; ${threads.all.length} were.`);
  }
  return thread;
}
function emit(thread: FakeThread, event: string, value: unknown): void {
  for (const handler of thread.listeners.get(event) ?? []) {
    (handler as (value: unknown) => void)(value);
  }
}
function deliver(thread: FakeThread, reply: ReportWorkerReply): void {
  emit(thread, 'message', reply);
}
/** Lets every queued microtask and promise continuation run. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 10; turn += 1) {
    await Promise.resolve();
  }
}
function status(worker: DebugReportWorker): Promise<unknown> {
  return worker.status(RECEIPT_ID, RECEIPT_TOKEN);
}
/** The settled outcome of a promise, or `waiting` if it has not settled after `settle()`. */
async function outcome(promise: Promise<unknown>): Promise<unknown> {
  let result: unknown = 'waiting';
  promise.then(
    (value) => {
      result = { resolved: value };
    },
    (error: unknown) => {
      result = error;
    }
  );
  await settle();
  return result;
}
function budgetSpentLogs(): unknown[] {
  return serverLogging.error.mock.calls
    .filter(([, message]) => message === 'Debug report worker replacement budget is spent')
    .map(([, , context]) => context);
}
/** Kills the current thread and asks for a replacement, which must start. */
async function replaceCurrent(worker: DebugReportWorker): Promise<void> {
  const before = threads.all.length;
  exitThread(threadAt(before - 1), 7);
  await expect(status(worker)).rejects.toMatchObject({ message: RESTARTING });
  await settle();
  expect(threads.all).toHaveLength(before + 1);
}
const MINUTE = 60_000;
function replacementsLogged(): number {
  return serverLogging.warn.mock.calls.filter(
    ([, message]) => message === 'Replacing the debug report worker'
  ).length;
}

test('concurrent requests after one fault start one replacement between them', async () => {
  threads.holdExits = true;
  const worker = start();
  emit(threadAt(0), 'error', new Error('SQLITE_IOERR: disk I/O error'));

  // The HTTP layer admits two uploads and any number of status reads at once.
  // An entry that tested "failed" and cleared it across an `await` let each of
  // these start its own replacement: three of them spent the whole budget and
  // spawned four threads.
  const arrivals = [status(worker), status(worker), status(worker), worker.enqueue('{}', 'a', {})];
  for (const arrival of arrivals) {
    await expect(arrival).rejects.toMatchObject({ status: 503, message: RESTARTING });
  }
  exitThread(threadAt(0), 1);
  await settle();

  expect(threads.all).toHaveLength(2);
  expect(replacementsLogged()).toBe(1);
  expect(serverLogging.warn).toHaveBeenCalledWith(
    'DEBUG_REPORTS',
    'Replacing the debug report worker',
    { replacement: 1, of: 3, windowMs: 3_600_000 }
  );
});

test('a replacement is constructed only after its predecessor has exited', async () => {
  vi.useFakeTimers();
  threads.holdExits = true;
  const worker = start();

  // A thread that fails on its own is retired at once.
  emit(threadAt(0), 'error', new Error('SQLITE_CANTOPEN: unable to open database file'));
  expect(threadAt(0).terminated).toBe(1);
  await expect(status(worker)).rejects.toMatchObject({ message: RESTARTING });
  await settle();
  // It has been told to stop but still holds the store. A replacement built
  // now would race it for the exclusive lock and die on arrival -- or, without
  // that lock, run a second connection and delivery interval over the same rows.
  expect(threads.all).toHaveLength(1);
  exitThread(threadAt(0), 1);
  await settle();
  expect(threads.all).toHaveLength(2);
  expect(threadAt(1).coexisting).toBe(0);

  // A thread that stalls past the request deadline is the case that leaves a
  // live thread behind. It too is retired the moment its deadline fires, not
  // when a replacement is wanted, because until then it keeps its connection
  // and its one-second delivery interval.
  const stalled = worker.enqueue('{}', 'address', {});
  const timedOut = expect(stalled).rejects.toMatchObject({ status: 503 });
  vi.advanceTimersByTime(10_000);
  await timedOut;
  expect(threadAt(1).terminated).toBe(1);
  await expect(status(worker)).rejects.toMatchObject({ message: RESTARTING });
  await settle();
  expect(threads.all).toHaveLength(2);
  exitThread(threadAt(1), 1);
  await settle();
  expect(threads.all).toHaveLength(3);
  expect(threadAt(2).coexisting).toBe(0);
});

test('closing during a handover waits for the retiring thread and starts no replacement', async () => {
  threads.holdExits = true;
  const worker = start();
  emit(threadAt(0), 'error', new Error('SQLITE_IOERR: disk I/O error'));
  await expect(status(worker)).rejects.toMatchObject({ message: RESTARTING });

  // Shutdown arrives while the replacement waits for the old thread to go.
  // Resolving now would let the process exit with that thread still holding
  // the event loop; spawning afterwards would leave a thread nobody stops.
  const closed = worker.close();
  expect(await outcome(closed)).toBe('waiting');

  exitThread(threadAt(0), 1);
  expect(await outcome(closed)).toEqual({ resolved: undefined });
  await settle();
  expect(threads.all).toHaveLength(1);
  await expect(status(worker)).rejects.toMatchObject({ message: UNAVAILABLE });
});

test('closing after a replacement checkpoints and stops the replacement', async () => {
  const worker = start();
  emit(threadAt(0), 'error', new Error('SQLITE_IOERR: disk I/O error'));
  await expect(status(worker)).rejects.toMatchObject({ message: RESTARTING });
  await settle();
  expect(threads.all).toHaveLength(2);

  // Only the thread that exists is asked to close, which runs its WAL
  // checkpoint; the one it replaced has already exited.
  const closed = worker.close();
  expect(threadAt(1).sent).toContainEqual(expect.objectContaining({ type: 'close' }));
  expect(threadAt(0).sent).toEqual([]);
  expect(await outcome(closed)).toBe('waiting');
  exitThread(threadAt(1), 0);
  expect(await outcome(closed)).toEqual({ resolved: undefined });
  expect(threads.all.every((thread) => thread.exited)).toBe(true);
});

test('a replacement that measures the queue and then dies does not refill the budget', async () => {
  vi.useFakeTimers();
  const worker = start();

  for (let replacement = 1; replacement <= 3; replacement += 1) {
    exitThread(threadAt(replacement - 1), 7);
    await expect(status(worker)).rejects.toMatchObject({ message: RESTARTING });
    await settle();
    expect(threads.all).toHaveLength(replacement + 1);
    // The store answered. Resetting the budget on this signal let every thread
    // that measured once before dying refill it, so it bounded nothing.
    deliver(threadAt(replacement), { type: 'diagnostics', diagnostics: { ...MEASURED } });
    expect(worker.diagnostics()).toEqual(MEASURED);
  }

  exitThread(threadAt(3), 7);
  await expect(status(worker)).rejects.toMatchObject({ message: UNAVAILABLE });
  await expect(status(worker)).rejects.toMatchObject({ message: UNAVAILABLE });
  await settle();
  expect(threads.all).toHaveLength(4);
  expect(replacementsLogged()).toBe(3);
  // Spent once, logged once, with when the next attempt becomes possible.
  expect(budgetSpentLogs()).toEqual([
    expect.objectContaining({ replacements: 3, windowMs: 3_600_000, nextAttemptInMs: 3_600_000 }),
  ]);

  // Only the clock refills it: an hour after the first replacement, a later
  // request may start another.
  vi.advanceTimersByTime(3_600_000);
  await expect(status(worker)).rejects.toMatchObject({ message: RESTARTING });
  await settle();
  expect(threads.all).toHaveLength(5);
});

test('a request that arrives during a handover is refused at once and cannot judge the replacement', async () => {
  vi.useFakeTimers();
  threads.holdExits = true;
  const worker = start();
  emit(threadAt(0), 'error', new Error('SQLITE_IOERR: disk I/O error'));

  // Refused before any time passes. A request that waited for the handover
  // spent its own deadline on it: HTTP answered 408 while the operation stayed
  // pending, and the worker's deadline then fired on the replacement.
  const refused = status(worker);
  const result = await outcome(refused);
  expect(result).toBeInstanceOf(DebugReportError);
  expect(result).toMatchObject({ status: 503, message: RESTARTING });

  exitThread(threadAt(0), 1);
  await settle();
  expect(threads.all).toHaveLength(2);
  // The refused request was not forwarded, so nothing on the new thread is
  // waiting for it and no deadline is running against the replacement.
  expect(threadAt(1).sent).toEqual([]);
  vi.advanceTimersByTime(20_000);
  expect(threadAt(1).terminated).toBe(0);
  expect(serverLogging.error).toHaveBeenCalledTimes(1);

  // And the replacement serves the next request.
  const answered = status(worker);
  const request = threadAt(1).sent.at(-1);
  if (request?.type !== 'status') {
    throw new Error('The status request was not forwarded to the replacement.');
  }
  deliver(threadAt(1), {
    type: 'result',
    requestId: request.requestId,
    receipt: { id: RECEIPT_ID, state: 'pending' },
  });
  await expect(answered).resolves.toEqual({ id: RECEIPT_ID, state: 'pending' });
});

test('the replacement budget is a rolling hour, not a fixed one', async () => {
  vi.useFakeTimers();
  const worker = start();

  await replaceCurrent(worker); // 0 min
  vi.advanceTimersByTime(30 * MINUTE);
  await replaceCurrent(worker); // 30 min
  vi.advanceTimersByTime(29 * MINUTE);
  await replaceCurrent(worker); // 59 min

  // The 0-minute replacement leaves the window at 60 minutes, so exactly one
  // more is allowed then.
  vi.advanceTimersByTime(MINUTE);
  await replaceCurrent(worker); // 60 min
  exitThread(threadAt(4), 7);
  await expect(status(worker)).rejects.toMatchObject({ message: UNAVAILABLE });
  expect(budgetSpentLogs()).toEqual([expect.objectContaining({ nextAttemptInMs: 30 * MINUTE })]);

  // The 30-minute one holds the window shut until 90 minutes.
  vi.advanceTimersByTime(30 * MINUTE - 1);
  await expect(status(worker)).rejects.toMatchObject({ message: UNAVAILABLE });
  await settle();
  expect(threads.all).toHaveLength(5);
  expect(budgetSpentLogs()).toHaveLength(1);
  vi.advanceTimersByTime(1);
  await expect(status(worker)).rejects.toMatchObject({ message: RESTARTING });
  await settle();
  expect(threads.all).toHaveLength(6);
});

test('a replacement thread that cannot start is logged and may be tried again', async () => {
  const worker = start();
  threads.refuseConstructions = 1;
  exitThread(threadAt(0), 7);

  await expect(status(worker)).rejects.toMatchObject({ message: RESTARTING });
  await settle();
  expect(threads.all).toHaveLength(1);
  expect(serverLogging.error).toHaveBeenCalledWith(
    'DEBUG_REPORTS',
    'Debug report worker could not be replaced',
    { error: expect.objectContaining({ message: expect.stringContaining('ERR_WORKER_INIT') }) }
  );

  // No thread is running, which is fail-closed, and the budget still has room.
  await expect(status(worker)).rejects.toMatchObject({ message: RESTARTING });
  await settle();
  expect(threads.all).toHaveLength(2);
  expect(replacementsLogged()).toBe(2);
});

test('a retired thread that never exits is reported as stuck, not as restarting', async () => {
  vi.useFakeTimers();
  threads.holdExits = true;
  const worker = start();
  emit(threadAt(0), 'error', new Error('SQLITE_IOERR: disk I/O error'));
  await expect(status(worker)).rejects.toMatchObject({ message: RESTARTING });

  // Its SQLite call never returns, so `terminate()` never completes. Without a
  // bound every refusal would promise a restart forever, with nothing logged.
  vi.advanceTimersByTime(9_999);
  await expect(status(worker)).rejects.toMatchObject({ message: RESTARTING });
  vi.advanceTimersByTime(1);
  expect(serverLogging.error).toHaveBeenCalledWith(
    'DEBUG_REPORTS',
    'The previous debug report worker has not exited; reporting stays closed until it does',
    { waitedMs: 10_000 }
  );
  expect(worker.diagnostics()).toMatchObject({
    pending: null,
    lastError: 'Debug report worker has not stopped. Keep your local copy.',
  });
  await expect(status(worker)).rejects.toMatchObject({ message: UNAVAILABLE });
  await settle();
  // Still one thread, and no further attempt spent while it holds the store.
  expect(threads.all).toHaveLength(1);
  expect(replacementsLogged()).toBe(1);

  // Once it does exit, a later request may replace it.
  exitThread(threadAt(0), 1);
  await expect(status(worker)).rejects.toMatchObject({ message: RESTARTING });
  await settle();
  expect(threads.all).toHaveLength(2);
  expect(threadAt(1).coexisting).toBe(0);
});

test('closing gives up on a retiring thread that never exits at the close deadline', async () => {
  vi.useFakeTimers();
  threads.holdExits = true;
  const worker = start();
  emit(threadAt(0), 'error', new Error('SQLITE_IOERR: disk I/O error'));
  expect(threadAt(0).terminated).toBe(1);

  const closed = worker.close();
  vi.advanceTimersByTime(1_999);
  expect(await outcome(closed)).toBe('waiting');
  vi.advanceTimersByTime(1);
  expect(await outcome(closed)).toEqual({ resolved: undefined });
  expect(threadAt(0).terminated).toBe(2);
});

test('closing terminates a live thread that ignores the close message at the deadline', async () => {
  vi.useFakeTimers();
  threads.holdExits = true;
  const worker = start();

  const closed = worker.close();
  expect(threadAt(0).sent).toContainEqual(expect.objectContaining({ type: 'close' }));
  vi.advanceTimersByTime(1_999);
  expect(await outcome(closed)).toBe('waiting');
  expect(threadAt(0).terminated).toBe(0);
  vi.advanceTimersByTime(1);
  expect(await outcome(closed)).toEqual({ resolved: undefined });
  expect(threadAt(0).terminated).toBe(1);
});

test('a close that ends on exit leaves no deadline running', async () => {
  vi.useFakeTimers();
  const worker = start();

  const closed = worker.close();
  exitThread(threadAt(0), 0);
  expect(await outcome(closed)).toEqual({ resolved: undefined });
  expect(vi.getTimerCount()).toBe(0);
});
