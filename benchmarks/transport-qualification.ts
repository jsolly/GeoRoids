import type { ProxyCounters } from './proxy-control';
import type { ServerProcessUsage } from './server-process-usage';

export function requireNegotiatedCompression(
  mode: ServerProcessUsage['compression'],
  header: string
): void {
  const fields = header
    .split(';')
    .map((field) => field.trim().toLowerCase())
    .filter(Boolean);
  if (mode === 'none') {
    if (fields.length > 0) {
      throw new Error('Uncompressed benchmark negotiated a WebSocket extension');
    }
    return;
  }
  if (
    fields[0] !== 'permessage-deflate' ||
    !fields.includes('server_no_context_takeover') ||
    !fields.includes('client_no_context_takeover') ||
    fields.some(
      (field) =>
        ![
          'permessage-deflate',
          'server_no_context_takeover',
          'client_no_context_takeover',
          'server_max_window_bits=15',
          'client_max_window_bits=15',
        ].includes(field)
    ) ||
    new Set(fields).size !== fields.length
  ) {
    throw new Error('Benchmark did not negotiate its declared no-context compression');
  }
}

export function measureServerProcessCpu(start: ServerProcessUsage, end: ServerProcessUsage) {
  const wallMs = end.monotonicMs - start.monotonicMs;
  const userMicroseconds = end.user - start.user;
  const systemMicroseconds = end.system - start.system;
  if (
    start.compression !== end.compression ||
    !Number.isFinite(wallMs) ||
    wallMs <= 0 ||
    !Number.isSafeInteger(userMicroseconds) ||
    userMicroseconds < 0 ||
    !Number.isSafeInteger(systemMicroseconds) ||
    systemMicroseconds < 0 ||
    !Number.isSafeInteger(userMicroseconds + systemMicroseconds)
  ) {
    throw new Error('Server process CPU boundary regressed or changed compression mode');
  }
  return {
    scope:
      'Cumulative server process CPU, including worker threads; separate from driver CPU and main-isolate profiler.',
    compression: start.compression,
    start,
    end,
    wallMs,
    userMicroseconds,
    systemMicroseconds,
    totalMicroseconds: userMicroseconds + systemMicroseconds,
    utilizationPercent: (userMicroseconds + systemMicroseconds) / (wallMs * 10),
  };
}

/** Compare only counters from one live proxy and its own monotonic clock. */
export function measureProxyTransport({
  start,
  end,
  profile,
}: {
  start: ProxyCounters;
  end: ProxyCounters;
  profile: ProxyCounters['profile'];
}) {
  const wallMs = end.monotonicMs - start.monotonicMs;
  const bytesUp = end.bytesUp - start.bytesUp;
  const bytesDown = end.bytesDown - start.bytesDown;
  const cumulativeFields = [
    'bytesUp',
    'bytesDown',
    'peakWritableBytes',
    'peakPendingDeliveryBytes',
    'failures',
  ] as const;
  if (
    !start.instanceId ||
    start.instanceId !== end.instanceId ||
    start.profile !== profile ||
    end.profile !== profile ||
    !Number.isFinite(start.monotonicMs) ||
    start.monotonicMs < 0 ||
    start.monotonicMs > Number.MAX_SAFE_INTEGER ||
    !Number.isFinite(end.monotonicMs) ||
    end.monotonicMs > Number.MAX_SAFE_INTEGER ||
    !Number.isFinite(wallMs) ||
    wallMs <= 0 ||
    cumulativeFields.some(
      (field) =>
        !Number.isSafeInteger(start[field]) ||
        start[field] < 0 ||
        !Number.isSafeInteger(end[field]) ||
        end[field] < start[field]
    ) ||
    !Number.isSafeInteger(bytesUp) ||
    bytesUp <= 0 ||
    !Number.isSafeInteger(bytesDown) ||
    bytesDown <= 0 ||
    !Number.isSafeInteger(bytesUp + bytesDown) ||
    start.failures !== 0 ||
    end.failures !== 0
  ) {
    throw new Error(
      'Proxy transport boundary changed identity/profile, regressed, failed, or lacks measured traffic'
    );
  }
  const upBytesPerSecond = (bytesUp * 1000) / wallMs;
  const downBytesPerSecond = (bytesDown * 1000) / wallMs;
  if (!Number.isFinite(upBytesPerSecond) || !Number.isFinite(downBytesPerSecond)) {
    throw new Error('Proxy transport rates exceed their finite numeric bound');
  }
  return {
    scope:
      'Raw TCP stream chunks admitted to outbound delivery; includes WebSocket/HTTP framing and any in-flight warmup bytes crossing the window, excludes TCP/IP headers and retransmission overhead.',
    profile,
    instanceId: start.instanceId,
    start,
    end,
    wallMs,
    bytesUp,
    bytesDown,
    totalBytes: bytesUp + bytesDown,
    upBytesPerSecond,
    downBytesPerSecond,
    peakPolicy:
      'Raw boundary peaks and whole-session proxy stats are cumulative diagnostics, not measured-window maxima.',
  };
}
