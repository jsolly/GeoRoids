/* @vitest-environment node */
import { afterEach, expect, test, vi } from 'vitest';
import {
  DebugReportWorker,
  type ReportWorkerReply,
  type ReportWorkerRequest,
} from '../../../server/debugReports/client';

/** One spawned thread: what the client sent it, and the handlers it attached. */
interface FakeThread {
  sent: ReportWorkerRequest[];
  listeners: Map<string, ((value: never) => void)[]>;
  terminated: number;
}

// One thread, because the class under test constructs exactly one and never
// replaces it. An earlier revision of this branch had a worker restart and this
// fake held a list of generations to match; keeping that shape would let a test
// express a handover the shipped class cannot perform.
const threads = vi.hoisted(() => ({ live: undefined as FakeThread | undefined }));
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
      threads.live = this.thread;
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
  threads.live = undefined;
  vi.clearAllMocks();
});

function thread(): FakeThread {
  const live = threads.live;
  if (!live) {
    throw new Error('The worker thread was never constructed.');
  }
  return live;
}
function emit(event: string, value: unknown): void {
  for (const handler of thread().listeners.get(event) ?? []) {
    (handler as (value: unknown) => void)(value);
  }
}
function deliver(reply: ReportWorkerReply): void {
  emit('message', reply);
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
  deliver({ type: 'diagnostics', diagnostics: { ...MEASURED } });
  expect(worker.diagnostics()).toEqual(MEASURED);

  emit('error', new Error('SQLITE_CANTOPEN: unable to open database file'));

  // `/health` publishes this for an operator to read: a fault means the depth is
  // no longer measured, and the cause has to survive. Nothing automated asserts
  // it -- the production smoke receipt fetches `/health` but reads only
  // `world.*` -- which is exactly why the guard has to live here.
  expect(worker.diagnostics()).toEqual(UNKNOWN_AFTER_FAULT);

  // A separate diagnostics message, already in flight, carrying counts taken
  // before the failure. Accepting it would leave `/health` reporting a healthy
  // queue while every submission answers 503.
  deliver({ type: 'diagnostics', diagnostics: { ...MEASURED } });
  expect(worker.diagnostics()).toEqual(UNKNOWN_AFTER_FAULT);
});

test('a graceful stop records the reason without reporting a storage fault', async () => {
  const worker = new DebugReportWorker(CONFIG);
  deliver({ type: 'diagnostics', diagnostics: { ...MEASURED } });

  const stopped = worker.close();
  emit('exit', 0);
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
  emit('error', failure);

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
  emit('exit', 3);

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
    expect(thread().terminated).toBe(1);
    emit('exit', 1);

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
      deliver({ type: 'fault', detail });
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
    deliver({ type: 'fault', detail: 'Error: SQLITE_FULL: database or disk is full' });
    expect(serverLogging.error).toHaveBeenCalledTimes(1);

    // Still failing a quarter of an hour on earns exactly one more record,
    // carrying the count it stood in for, so a long outage leaves a trail.
    vi.advanceTimersByTime(900_000);
    deliver({ type: 'fault', detail });
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
      deliver({ type: 'fault', detail });
      deliver({ type: 'diagnostics', diagnostics: { ...MEASURED } });
      vi.advanceTimersByTime(1_000);
    }
    expect(serverLogging.error).toHaveBeenCalledTimes(1);
    expect(serverLogging.warn).not.toHaveBeenCalled();

    // The episode closes only once the store has actually gone quiet.
    vi.advanceTimersByTime(60_000);
    deliver({ type: 'diagnostics', diagnostics: { ...MEASURED } });
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

test('a storage fault detail never reaches the public health surface', () => {
  const worker = new DebugReportWorker(CONFIG);
  const secret = 'SQLITE_CANTOPEN: /data/debug-reports.sqlite at DebugReportStore.open';

  deliver({ type: 'fault', detail: secret });

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
    deliver({ type: 'fault', detail });
  }
  expect(serverLogging.error).toHaveBeenCalledTimes(1);

  // The count is the only record of how long the episode ran. Abandoning the
  // episode here loses it on exactly the sequence worth reading: a store starts
  // failing, faults repeatedly, and then takes the worker down.
  emit('error', new Error('SQLITE_CANTOPEN: unable to open database file'));

  expect(serverLogging.warn).toHaveBeenCalledWith(
    'DEBUG_REPORTS',
    'Debug report storage fault episode ended',
    // The outcome names the cause rather than flattening every failure to one
    // label: spelling the outcomes out by hand had a request timeout reported
    // as `worker-failed`, which is the mislabelling the typed cause removed.
    { suppressedFaults: 11, outcome: 'uncaught' }
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
