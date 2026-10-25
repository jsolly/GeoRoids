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

  // `/health` reads this, and the smoke receipt reads `/health`: a fault means
  // the depth is no longer measured, and the cause has to survive.
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
  expect(worker.diagnostics()).toEqual({
    pending: null,
    blocked: null,
    oldestPendingAt: null,
    lastError: null,
  });
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
