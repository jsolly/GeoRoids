const LIMIT = 128;
let nextEpoch = 0;

type Tick = { sequence: number; monotonicMs: number; timeOrigin: number; wallMs: number };
function isTick(value: unknown): value is Tick {
  return (
    typeof value === 'object' &&
    value !== null &&
    'sequence' in value &&
    typeof value.sequence === 'number' &&
    Number.isSafeInteger(value.sequence) &&
    value.sequence > 0 &&
    'monotonicMs' in value &&
    typeof value.monotonicMs === 'number' &&
    Number.isFinite(value.monotonicMs) &&
    'timeOrigin' in value &&
    typeof value.timeOrigin === 'number' &&
    Number.isFinite(value.timeOrigin) &&
    'wallMs' in value &&
    typeof value.wallMs === 'number' &&
    Number.isFinite(value.wallMs)
  );
}

/** Owned only by an explicit phone recording. Missing worker evidence remains unknown. */
export function startRecordingHeartbeat() {
  const epoch = ++nextEpoch;
  let worker: Worker | undefined;
  let status: 'starting' | 'available' | 'unavailable' | 'failed' | 'stopped' = 'starting';
  let visibilityEpoch = 0;
  let observed = 0;
  let previous: Tick | undefined;
  let previousReceived: { monotonicMs: number; wallMs: number } | undefined;
  let lifecycleCount = 0;
  const lifecycle: {
    event: string;
    monotonicMs: number;
    wallMs: number;
    visibility: DocumentVisibilityState;
    visibilityEpoch: number;
  }[] = [];
  const ticks: (Tick & {
    receivedMs: number;
    receivedWallMs: number;
    visibility: DocumentVisibilityState;
    visibilityEpoch: number;
    senderGapMs: number | null;
    receiverGapMs: number | null;
    sequenceGap: number | null;
    clockJump: boolean;
  })[] = [];
  const visibility = (event: Event) => {
    visibilityEpoch++;
    lifecycleCount++;
    if (lifecycle.length < 16) {
      lifecycle.push({
        event: event.type,
        monotonicMs: performance.now(),
        wallMs: Date.now(),
        visibility: document.visibilityState,
        visibilityEpoch,
      });
    }
  };
  const scope = new AbortController();
  for (const event of ['visibilitychange', 'freeze', 'resume']) {
    document.addEventListener(event, visibility, { capture: true, signal: scope.signal });
  }
  for (const event of ['pageshow', 'pagehide']) {
    window.addEventListener(event, visibility, { capture: true, signal: scope.signal });
  }
  const stopWorker = () => {
    if (worker) {
      worker.onmessage = null;
      worker.onerror = null;
      worker.onmessageerror = null;
      worker.terminate();
    }
    worker = undefined;
  };
  try {
    worker = new Worker(new URL('./recordingHeartbeat.worker.ts', import.meta.url), {
      type: 'module',
    });
    worker.onmessage = (event: MessageEvent<unknown>) => {
      if (status === 'stopped' || status === 'failed') {
        return;
      }
      if (!isTick(event.data)) {
        status = 'failed';
        stopWorker();
        return;
      }
      const tick = event.data;
      const receivedMs = performance.now();
      const receivedWallMs = Date.now();
      status = 'available';
      observed++;
      const senderGapMs = previous ? tick.monotonicMs - previous.monotonicMs : null;
      const receiverGapMs = previousReceived ? receivedMs - previousReceived.monotonicMs : null;
      const clockJump = Boolean(
        previous &&
          previousReceived &&
          (tick.timeOrigin !== previous.timeOrigin ||
            tick.sequence <= previous.sequence ||
            (senderGapMs !== null &&
              (senderGapMs < 0 || Math.abs(tick.wallMs - previous.wallMs - senderGapMs) > 500)) ||
            (receiverGapMs !== null &&
              (receiverGapMs < 0 ||
                Math.abs(receivedWallMs - previousReceived.wallMs - receiverGapMs) > 500)))
      );
      if (ticks.length < LIMIT) {
        ticks.push({
          ...tick,
          receivedMs,
          receivedWallMs,
          visibility: document.visibilityState,
          visibilityEpoch,
          senderGapMs,
          receiverGapMs,
          sequenceGap: previous ? tick.sequence - previous.sequence : null,
          clockJump,
        });
      }
      previous = tick;
      previousReceived = { monotonicMs: receivedMs, wallMs: receivedWallMs };
    };
    worker.onerror = () => {
      status = 'failed';
      stopWorker();
    };
    worker.onmessageerror = () => {
      status = 'failed';
      stopWorker();
    };
  } catch {
    status = 'unavailable';
    stopWorker();
  }
  return {
    read() {
      const result = {
        epoch,
        status,
        intervalMs: 100,
        limit: LIMIT,
        observed,
        omitted: observed - ticks.length,
        visibility: document.visibilityState,
        visibilityEpoch,
        lifecycle: {
          observed: lifecycleCount,
          omitted: lifecycleCount - lifecycle.length,
          values: lifecycle.splice(0),
        },
        interpretation:
          'continuous-sender-with-delayed-receipt-supports-main-blocking; gaps-in-both-are-ambiguous; no-memory-causality',
        ticks: ticks.splice(0),
      };
      observed = 0;
      lifecycleCount = 0;
      return result;
    },
    dispose() {
      status = 'stopped';
      stopWorker();
      scope.abort();
    },
  };
}
