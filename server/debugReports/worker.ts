import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { MAX_DEBUG_REPORT_BYTES, parseDebugReportSubmission } from '../../shared/debugReports';
import type { ReportWorkerReply, ReportWorkerRequest } from './client';
import type { DebugReportConfiguration } from './configuration';
import { DebugReportStore, ReportStoreError } from './store';
import { TodoistDelivery, TodoistDeliveryError } from './todoist';

if (isMainThread || !parentPort) {
  throw new Error('Debug report worker must run on a dedicated thread');
}
const port = parentPort;
// Worker data is supplied only by the server-side constructor, never by HTTP input.
const config: DebugReportConfiguration = workerData;
const store = new DebugReportStore(config);
const delivery = new TodoistDelivery(config);
let closed = false;
let delivering = false;
const reply = (message: ReportWorkerReply): void => port.postMessage(message);
const statistics = (): void => reply({ type: 'diagnostics', diagnostics: store.diagnostics() });

async function deliverNext(): Promise<void> {
  if (closed || delivering) {
    return;
  }
  delivering = true;
  try {
    const report = store.next();
    if (report) {
      try {
        await delivery.deliver(report, store);
      } catch (error) {
        if (!closed) {
          const failure =
            error instanceof TodoistDeliveryError
              ? error
              : new TodoistDeliveryError('Todoist delivery is temporarily unavailable.', false);
          const exponential = Math.min(900_000, 5_000 * 2 ** Math.min(report.attempts, 8));
          const delay = failure.blocked
            ? Math.max(900_000, failure.retryAfterMs)
            : Math.max(
                failure.retryAfterMs,
                exponential + Math.floor(Math.random() * exponential * 0.2)
              );
          store.defer(report.id, failure.blocked, failure.message, Date.now() + delay);
        }
      }
    }
    if (!closed) {
      statistics();
    }
  } catch (error) {
    if (!closed) {
      // `/health` is public, so the message stays generic and the cause goes to
      // the parent thread to be logged there. The counts are null because this
      // failure means the depth was never measured.
      reply({
        type: 'fault',
        detail: error instanceof Error ? (error.stack ?? error.message) : String(error),
      });
      reply({
        type: 'diagnostics',
        diagnostics: {
          pending: null,
          blocked: null,
          oldestPendingAt: null,
          lastError: 'Debug report storage is unavailable.',
        },
      });
    }
  } finally {
    delivering = false;
  }
}
const timer = setInterval(() => {
  void deliverNext();
}, 1_000);
port.on('message', (request: ReportWorkerRequest) => {
  if (request.type === 'close') {
    closed = true;
    clearInterval(timer);
    store.close();
    reply({ type: 'closed', requestId: request.requestId });
    port.close();
    return;
  }
  try {
    if (closed) {
      throw new ReportStoreError(503, 'Debug report storage is closing.');
    }
    if (request.type === 'status') {
      reply({
        type: 'result',
        requestId: request.requestId,
        receipt: store.status(request.id, request.receiptToken),
      });
    } else {
      if (Buffer.byteLength(request.body) > MAX_DEBUG_REPORT_BYTES) {
        throw new ReportStoreError(413, 'Debug report exceeds 2 MiB.');
      }
      let submission: ReturnType<typeof parseDebugReportSubmission> | undefined;
      try {
        submission = parseDebugReportSubmission(JSON.parse(request.body));
      } catch {
        submission = undefined;
      }
      if (submission === undefined) {
        throw new ReportStoreError(400, 'Invalid debug report. Keep your local copy.');
      }
      const receipt = store.accept(submission, request.address, request.health);
      reply({ type: 'result', requestId: request.requestId, receipt });
      statistics();
      void deliverNext();
    }
  } catch (error) {
    reply({
      type: 'error',
      requestId: request.requestId,
      status: error instanceof ReportStoreError ? error.status : 503,
      message:
        error instanceof ReportStoreError
          ? error.message
          : 'Debug report could not be saved. Keep your local copy.',
    });
  }
});
statistics();
void deliverNext();
