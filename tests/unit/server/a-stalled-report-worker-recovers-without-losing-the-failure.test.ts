/* @vitest-environment node */
import { afterEach, expect, test, vi } from 'vitest';
import {
  DebugReportWorker,
  MAX_WORKER_RESTARTS,
  type ReportWorkerReply,
  type ReportWorkerRequest,
} from '../../../server/debugReports/client';

/** One spawned thread: what the client sent it, and the handlers it attached. */
interface FakeThread {
  sent: ReportWorkerRequest[];
  listeners: Map<string, ((value: never) => void)[]>;
  terminated: number;
}

const threads = vi.hoisted(() => ({ spawned: [] as FakeThread[] }));
const serverLogging = vi.hoisted(() => ({ error: vi.fn(), warn: vi.fn() }));

vi.mock('../../../setup/serverLogger', () => ({
  logger: { error: serverLogging.error, warn: serverLogging.warn },
}));

// The thread is the external boundary. The fake supplies only transport and
// the failure event, never a queue depth the assertions claim or a decision
// about restarting; those rules belong to the client under test.
vi.mock('node:worker_threads', () => ({
  Worker: class {
    private readonly thread: FakeThread;
    constructor() {
      this.thread = { sent: [], listeners: new Map(), terminated: 0 };
      threads.spawned.push(this.thread);
    }
    on(event: string, handler: (value: never) => void): void {
      const attached = this.thread.listeners.get(event) ?? [];
      attached.push(handler);
      this.thread.listeners.set(event, attached);
    }
    once(event: string, handler: (value: never) => void): void {
      this.on(event, handler);
    }
    postMessage(request: ReportWorkerRequest): void {
      this.thread.sent.push(request);
    }
    terminate(): Promise<number> {
      this.thread.terminated += 1;
      return Promise.resolve(0);
    }
  },
}));

const CONFIG = {
  path: '/data/debug-reports.sqlite',
  token: 'delivery-token',
  projectId: 'project-restart',
  sectionId: 'section-restart',
};
const BODY = '{"version":1}';
const RECEIPT = { id: '8a1d0e7c-5f21-4a3b-9c6d-2e4b7f80a913', state: 'blocked' } as const;
const WORKER_UNAVAILABLE = 'Debug report worker is unavailable. Keep your local copy.';
/** Counts the thread measured while it was healthy. Spread at every use: the
 * expected values below are only independent while nothing can write to it. */
const MEASURED = {
  pending: 2,
  blocked: 1,
  oldestPendingAt: '2026-10-25T12:00:00.000Z',
  lastError: null,
} as const;
const UNKNOWN_AFTER_FAULT = {
  pending: null,
  blocked: null,
  oldestPendingAt: null,
  lastError: WORKER_UNAVAILABLE,
};

afterEach(() => {
  threads.spawned.length = 0;
  vi.clearAllMocks();
});

function thread(index: number): FakeThread {
  const spawned = threads.spawned[index];
  if (!spawned) {
    throw new Error(`No thread was spawned at index ${index}.`);
  }
  return spawned;
}
function emit(index: number, event: string, value: unknown): void {
  for (const handler of thread(index).listeners.get(event) ?? []) {
    (handler as (value: unknown) => void)(value);
  }
}
function deliver(index: number, reply: ReportWorkerReply): void {
  emit(index, 'message', reply);
}

test('a storage fault stays visible when the thread reports counts measured before it', () => {
  const worker = new DebugReportWorker(CONFIG);
  deliver(0, { type: 'diagnostics', diagnostics: { ...MEASURED } });
  expect(worker.diagnostics()).toEqual(MEASURED);

  emit(0, 'error', new Error('SQLITE_CANTOPEN: unable to open database file'));

  // `/health` publishes this for an operator to read: a fault means the depth is
  // no longer measured, and the cause has to survive. Nothing automated asserts
  // it -- the production smoke receipt fetches `/health` but reads only
  // `world.*` -- which is exactly why the guard has to live here.
  expect(worker.diagnostics()).toEqual(UNKNOWN_AFTER_FAULT);

  // A separate diagnostics message, already in flight, carrying counts taken
  // before the failure. Accepting it would leave `/health` reporting a healthy
  // queue while every submission answers 503.
  deliver(0, { type: 'diagnostics', diagnostics: { ...MEASURED } });
  expect(worker.diagnostics()).toEqual(UNKNOWN_AFTER_FAULT);
});

test('a faulted thread is replaced for a later report, a bounded number of times', async () => {
  const worker = new DebugReportWorker(CONFIG);
  expect(threads.spawned).toHaveLength(1);

  for (let attempt = 1; attempt <= MAX_WORKER_RESTARTS; attempt += 1) {
    emit(attempt - 1, 'error', new Error('SQLITE_IOERR: disk I/O error'));
    const accepted = worker.enqueue(BODY, 'address', {});
    // Without the replacement the report has nowhere to go: the request is
    // posted to the new thread, and the dead one is never written to again.
    expect(threads.spawned).toHaveLength(attempt + 1);
    expect(thread(attempt).sent).toEqual([
      { type: 'enqueue', requestId: attempt, body: BODY, address: 'address', health: {} },
    ]);
    deliver(attempt, { type: 'result', requestId: attempt, receipt: RECEIPT });
    await expect(accepted).resolves.toEqual(RECEIPT);
    expect(serverLogging.warn).toHaveBeenCalledTimes(attempt);
  }

  // Past the bound reporting stays closed rather than respawning forever
  // against a store that cannot be opened.
  emit(MAX_WORKER_RESTARTS, 'error', new Error('SQLITE_CORRUPT: database disk image is malformed'));
  await expect(worker.enqueue(BODY, 'address', {})).rejects.toMatchObject({ status: 503 });
  expect(threads.spawned).toHaveLength(MAX_WORKER_RESTARTS + 1);
});

test('a replaced thread exiting does not close the reporter that succeeded it', async () => {
  const worker = new DebugReportWorker(CONFIG);
  emit(0, 'error', new Error('SQLITE_BUSY: database is locked'));
  const accepted = worker.enqueue(BODY, 'address', {});
  expect(threads.spawned).toHaveLength(2);

  // A faulted thread, and one the request timeout terminates, both end with an
  // `exit` that can land after the request already replaced it. Attributing
  // either to the live thread would reject this report and shut reporting down
  // a second time, and its last counts describe a store the new thread owns.
  emit(0, 'exit', 1);
  deliver(0, {
    type: 'diagnostics',
    diagnostics: { pending: 5, blocked: 0, oldestPendingAt: null, lastError: null },
  });

  deliver(1, { type: 'result', requestId: 1, receipt: RECEIPT });
  await expect(accepted).resolves.toEqual(RECEIPT);
  // The depth is unknown until the new thread measures it, but the failure that
  // forced the restart is still the most recent thing known here. Clearing it
  // would undo the guard two tests above, whose purpose is to stop a recorded
  // failure being erased.
  expect(worker.diagnostics()).toEqual({
    pending: null,
    blocked: null,
    oldestPendingAt: null,
    lastError: WORKER_UNAVAILABLE,
  });

  // The new thread's first measured reply is what replaces it.
  deliver(1, { type: 'diagnostics', diagnostics: { ...MEASURED } });
  expect(worker.diagnostics()).toEqual(MEASURED);
});

test('a graceful stop records the reason without reporting a storage fault', async () => {
  const worker = new DebugReportWorker(CONFIG);
  deliver(0, { type: 'diagnostics', diagnostics: { ...MEASURED } });

  const stopped = worker.close();
  emit(0, 'exit', 0);
  await stopped;

  // `close()` routes through the same failure path, so an ordinary shutdown
  // can look like a dead store: that logs an ERROR on every clean stop, which
  // buries the real ones, and throws away a count that is still true.
  expect(serverLogging.error).not.toHaveBeenCalled();
  expect(worker.diagnostics()).toEqual({
    ...MEASURED,
    lastError: 'Debug report storage is closing.',
  });
});

test('the record an operator reads names the cause, with the errno that explains it', () => {
  const worker = new DebugReportWorker(CONFIG);
  const failure = new Error('SQLITE_CANTOPEN: unable to open database file');
  emit(0, 'error', failure);

  // Without this, a regression that drops the Error argument or logs at the
  // wrong level leaves the suite green while production records a storage
  // outage with no errno — which is the whole diagnostic for this worker.
  expect(serverLogging.error).toHaveBeenCalledWith('DEBUG_REPORTS', WORKER_UNAVAILABLE, {
    error: failure,
  });
  expect(worker.diagnostics().lastError).toBe(WORKER_UNAVAILABLE);
});

test('a thread that exits on its own reports the exit code, not a generic failure', () => {
  const worker = new DebugReportWorker(CONFIG);
  emit(0, 'exit', 3);

  expect(serverLogging.error).toHaveBeenCalledWith(
    'DEBUG_REPORTS',
    'Debug report worker stopped. Keep your local copy.',
    { exitCode: 3 }
  );
  expect(worker.diagnostics().lastError).toBe('Debug report worker stopped. Keep your local copy.');
});

test('a request that outlives its deadline reports the timeout once, not two other causes', async () => {
  vi.useFakeTimers();
  try {
    const worker = new DebugReportWorker(CONFIG);
    const pending = worker.enqueue(BODY, 'address', {});
    const rejected = expect(pending).rejects.toMatchObject({
      status: 503,
      message: 'Debug report storage timed out. Keep your local copy and retry later.',
    });

    // The documented ten-second request deadline.
    vi.advanceTimersByTime(10_000);

    // The deadline terminates the thread, and a real `terminate()` raises
    // `exit` on this same generation. That used to come back through `fail()`
    // and emit a second, contradictory record, so one stalled queue handed an
    // operator two disagreeing lines, neither of them naming a timeout.
    expect(thread(0).terminated).toBe(1);
    emit(0, 'exit', 1);

    expect(serverLogging.error).toHaveBeenCalledTimes(1);
    expect(serverLogging.error).toHaveBeenCalledWith(
      'DEBUG_REPORTS',
      'Debug report storage timed out. Keep your local copy and retry later.',
      { deadlineMs: 10_000 }
    );
    await rejected;
  } finally {
    vi.useRealTimers();
  }
});

test('a store that keeps faulting is logged once an episode, not once a second', () => {
  const worker = new DebugReportWorker(CONFIG);
  const detail = 'Error: SQLITE_IOERR: disk I/O error\n    at DebugReportStore.next';

  // The worker's delivery interval faults every second for as long as the store
  // stays broken. One ERROR per tick wrote ~86,400 stack traces a day, rotated
  // away every other diagnostic from the same incident, and pushed the log
  // writer into dropping other components' records.
  for (let tick = 0; tick < 600; tick += 1) {
    deliver(0, { type: 'fault', detail });
    deliver(0, {
      type: 'diagnostics',
      diagnostics: {
        pending: null,
        blocked: null,
        oldestPendingAt: null,
        lastError: 'Debug report storage is unavailable.',
      },
    });
  }
  expect(serverLogging.error).toHaveBeenCalledTimes(1);
  expect(serverLogging.error).toHaveBeenCalledWith('DEBUG_REPORTS', 'Debug report storage failed', {
    detail,
  });

  // A different cause is a different episode, so a changing fault is not lost
  // behind the first one.
  deliver(0, { type: 'fault', detail: 'Error: SQLITE_FULL: database or disk is full' });
  expect(serverLogging.error).toHaveBeenCalledTimes(2);

  // Recovery is one line carrying what was suppressed, so the volume is
  // recoverable from the log even though the records are not.
  deliver(0, { type: 'diagnostics', diagnostics: { ...MEASURED } });
  expect(serverLogging.warn).toHaveBeenCalledWith(
    'DEBUG_REPORTS',
    'Debug report storage stopped faulting',
    { suppressedFaults: 0 }
  );
  expect(worker.diagnostics()).toEqual(MEASURED);
});

test('a storage fault detail never reaches the public health surface', () => {
  const worker = new DebugReportWorker(CONFIG);
  const secret = 'SQLITE_CANTOPEN: /data/debug-reports.sqlite at DebugReportStore.open';

  deliver(0, { type: 'fault', detail: secret });

  // `/health` is unauthenticated. The detail exists so an operator can read the
  // cause in the server log; routing it into `lastError` instead would publish
  // a filesystem path and stack to anyone, on a subsystem whose sibling
  // integration test is named for keeping receipts private.
  const published = JSON.stringify(worker.diagnostics());
  expect(published).not.toContain('SQLITE_CANTOPEN');
  expect(published).not.toContain('/data/debug-reports.sqlite');
  expect(published).not.toContain('DebugReportStore');
  // And dropping the fault case entirely must not go unnoticed: the detail has
  // to reach the log instead.
  expect(serverLogging.error).toHaveBeenCalledWith('DEBUG_REPORTS', 'Debug report storage failed', {
    detail: secret,
  });
});
