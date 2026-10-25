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
      // Node raises `exit` once a terminated thread is gone, and that is the
      // signal the restart handover waits for. A fake that never emitted it
      // would let a missing handover pass.
      queueMicrotask(() => {
        for (const handler of this.thread.listeners.get('exit') ?? []) {
          (handler as (code: unknown) => void)(1);
        }
      });
      return Promise.resolve(1);
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
/** When two records must read in order, an absent call is the failure, not a skip. */
function callOrder(mock: { mock: { invocationCallOrder: number[] } }, index: number): number {
  const at = mock.mock.invocationCallOrder[index];
  if (at === undefined) {
    throw new Error(`Expected a logged record at index ${index}, but none was emitted.`);
  }
  return at;
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

    // The replacement must not exist yet. `DebugReportStore` is the only
    // connection to its database and opens with no busy timeout, so spawning
    // before the outgoing thread lets go raced it for the write lock and the
    // replacement died on arrival.
    expect(threads.spawned).toHaveLength(attempt);
    expect(thread(attempt - 1).terminated).toBe(1);

    await vi.waitFor(() => {
      expect(threads.spawned).toHaveLength(attempt + 1);
    });
    // Only then does the report go anywhere, and only to the new thread.
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
  await vi.waitFor(() => {
    expect(threads.spawned).toHaveLength(2);
  });

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

test('a store that keeps failing is logged on a clock, not once per delivery tick', () => {
  vi.useFakeTimers();
  try {
    const worker = new DebugReportWorker(CONFIG);
    const detail = 'Error: SQLITE_IOERR: disk I/O error\n    at DebugReportStore.next';
    // The published depth is not what this case is about, but it must stay
    // unknown throughout: a suppressed fault is still a fault.
    const unknownThroughout = (): void => {
      expect(worker.diagnostics().pending).toBeNull();
    };

    // The worker's delivery interval faults every second for as long as the
    // store stays broken. One ERROR per tick wrote ~86,400 stack traces a day,
    // rotated away every other diagnostic from the same incident, and pushed
    // the log writer into dropping other components' records.
    for (let tick = 0; tick < 600; tick += 1) {
      deliver(0, { type: 'fault', detail });
      vi.advanceTimersByTime(1_000);
    }
    expect(serverLogging.error).toHaveBeenCalledTimes(1);
    expect(serverLogging.error).toHaveBeenCalledWith(
      'DEBUG_REPORTS',
      'Debug report storage failed',
      { detail }
    );
    unknownThroughout();

    // A different cause inside the window is still suppressed. Keying the
    // episode on fault identity alone bounded nothing: a store whose error
    // text varies -- or which alternates between two causes -- opened a fresh
    // episode every tick and logged every one of them.
    deliver(0, { type: 'fault', detail: 'Error: SQLITE_FULL: database or disk is full' });
    expect(serverLogging.error).toHaveBeenCalledTimes(1);

    // Still failing a quarter of an hour on earns exactly one more record,
    // carrying the count it stood in for, so a long outage leaves a trail.
    vi.advanceTimersByTime(900_000);
    deliver(0, { type: 'fault', detail });
    expect(serverLogging.error).toHaveBeenCalledTimes(2);
    expect(serverLogging.error).toHaveBeenLastCalledWith(
      'DEBUG_REPORTS',
      'Debug report storage still failing',
      // 599 of the identical ticks plus the one whose cause differed; the
      // first was logged rather than suppressed.
      { detail, suppressedSince: 600 }
    );
  } finally {
    vi.useRealTimers();
  }
});

test('a flapping store neither re-logs each fault nor claims recovery between them', () => {
  vi.useFakeTimers();
  try {
    const worker = new DebugReportWorker(CONFIG);
    const detail = 'Error: SQLITE_BUSY: database is locked';

    // The case identity-keyed collapsing missed entirely: a store that
    // alternates between failing and answering. Every measured reply used to
    // close the episode and every following fault opened a new one, so the
    // per-second flood came straight back -- now with a recovery line between
    // each pair, so the log also read as repeated recovery.
    for (let flap = 0; flap < 300; flap += 1) {
      deliver(0, { type: 'fault', detail });
      deliver(0, { type: 'diagnostics', diagnostics: { ...MEASURED } });
      vi.advanceTimersByTime(1_000);
    }
    expect(serverLogging.error).toHaveBeenCalledTimes(1);
    expect(serverLogging.warn).not.toHaveBeenCalled();

    // The episode closes only once the store has actually gone quiet.
    vi.advanceTimersByTime(60_000);
    deliver(0, { type: 'diagnostics', diagnostics: { ...MEASURED } });
    expect(serverLogging.warn).toHaveBeenCalledWith(
      'DEBUG_REPORTS',
      'Debug report storage fault episode ended',
      { suppressedFaults: 299, outcome: 'recovered' }
    );
    expect(worker.diagnostics()).toEqual(MEASURED);
  } finally {
    vi.useRealTimers();
  }
});

test('a replacement that proves it works restores the restart budget', async () => {
  const worker = new DebugReportWorker(CONFIG);

  // Three stalls days apart, each fully recovered, used to exhaust a
  // process-lifetime budget and close reporting permanently on a healthy
  // store. A measured depth is the one signal that proves a replacement
  // works, and a corrupt store never produces one, so resetting on it keeps
  // the anti-spin half of the bound intact.
  for (let incident = 1; incident <= MAX_WORKER_RESTARTS + 2; incident += 1) {
    emit(threads.spawned.length - 1, 'error', new Error('SQLITE_IOERR: disk I/O error'));
    const accepted = worker.enqueue(BODY, 'address', {});
    await vi.waitFor(() => {
      expect(threads.spawned).toHaveLength(incident + 1);
    });
    const live = threads.spawned.length - 1;
    deliver(live, { type: 'result', requestId: incident, receipt: RECEIPT });
    await expect(accepted).resolves.toEqual(RECEIPT);
    // Proof of life: the store answered with a real depth.
    deliver(live, { type: 'diagnostics', diagnostics: { ...MEASURED } });
  }

  // Five recovered incidents, more than the bound, and reporting is still open.
  expect(threads.spawned).toHaveLength(MAX_WORKER_RESTARTS + 3);
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

test('a worker that dies mid-episode still reports how many faults it suppressed', () => {
  const worker = new DebugReportWorker(CONFIG);
  const detail = 'Error: SQLITE_IOERR: disk I/O error';

  for (let tick = 0; tick < 12; tick += 1) {
    deliver(0, { type: 'fault', detail });
  }
  expect(serverLogging.error).toHaveBeenCalledTimes(1);

  // The count is the only record of how long the episode ran. Abandoning the
  // episode here loses it on exactly the sequence worth reading: a store starts
  // failing, faults repeatedly, and then takes the worker down.
  emit(0, 'error', new Error('SQLITE_CANTOPEN: unable to open database file'));

  expect(serverLogging.warn).toHaveBeenCalledWith(
    'DEBUG_REPORTS',
    'Debug report storage fault episode ended',
    { suppressedFaults: 11, outcome: 'worker-failed' }
  );
  // And it reads in order: the count before the cause that ended it.
  expect(callOrder(serverLogging.warn, 0)).toBeLessThan(callOrder(serverLogging.error, 1));

  // The fatal cause still lands, and the depth it leaves behind is unknown.
  expect(worker.diagnostics()).toEqual({
    pending: null,
    blocked: null,
    oldestPendingAt: null,
    lastError: WORKER_UNAVAILABLE,
  });
});
