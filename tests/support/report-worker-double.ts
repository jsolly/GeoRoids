import type { ReportWorkerReply, ReportWorkerRequest } from '../../server/debugReports/client';

export interface ReportThreadDouble {
  sent: ReportWorkerRequest[];
  listeners: Map<string, ((value: never) => void)[]>;
  terminated: number;
  exited: boolean;
  coexisting: number;
}

interface Threads {
  all: ReportThreadDouble[];
  holdExits: boolean;
  refuseConstructions: number;
}

export function emitReportThread(thread: ReportThreadDouble, event: string, value: unknown): void {
  for (const handler of thread.listeners.get(event) ?? []) {
    (handler as (value: unknown) => void)(value);
  }
}

export function exitReportThread(thread: ReportThreadDouble, code: number): void {
  if (!thread.exited) {
    thread.exited = true;
    emitReportThread(thread, 'exit', code);
  }
}

export function deliverReportReply(thread: ReportThreadDouble, reply: ReportWorkerReply): void {
  emitReportThread(thread, 'message', reply);
}

/** Only the external thread boundary is faked; recovery and logging remain production code. */
export function reportWorkerClass(threads: Threads) {
  return class {
    private readonly thread: ReportThreadDouble;
    constructor() {
      if (threads.refuseConstructions > 0) {
        threads.refuseConstructions--;
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
      const listeners = this.thread.listeners.get(event) ?? [];
      listeners.push(handler);
      this.thread.listeners.set(event, listeners);
    }
    postMessage(request: ReportWorkerRequest): void {
      this.thread.sent.push(request);
    }
    terminate(): Promise<number> {
      this.thread.terminated++;
      if (!threads.holdExits) {
        queueMicrotask(() => exitReportThread(this.thread, 1));
      }
      return Promise.resolve(1);
    }
  };
}
