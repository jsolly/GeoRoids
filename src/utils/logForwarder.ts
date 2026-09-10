import {
  createLogRecord,
  LOG_LINE_MAX_BYTES,
  parseLogRecord,
  stringifyLogRecord,
} from '../../shared/logRecords';
import { getClientLogContext } from './clientLogContext';
import { logsWebSocketUrlFromGameplay } from './logsWebSocketUrl';

type QueuedLine = { line: string; bytes: number };

let ws: WebSocket | null = null;
let messageQueue: QueuedLine[] = [];
let queuedBytes = 0;
let reconnectTimer: number | null = null;
let handshakeTimer: number | null = null;
let isInitialized = false;
let droppedMessageCount = 0;
let reportedDroppedMessageCount = 0;
let transportFailureReported = false;

const MAX_QUEUE_BYTES = 256 * 1024;
const RECONNECT_DELAY_MS = 5000;
const HANDSHAKE_TIMEOUT_MS = 10_000;
const MAX_SOCKET_BUFFERED_BYTES = 64 * 1024;

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function safePageUrl(): string {
  try {
    const url = new URL(location.href);
    return `${url.origin}${url.pathname}`;
  } catch {
    return '/';
  }
}

function normalizeLine(line: string): QueuedLine {
  let normalized = line;
  if (byteLength(normalized) > LOG_LINE_MAX_BYTES) {
    const parsed = parseLogRecord(line);
    normalized = stringifyLogRecord(
      createLogRecord({
        timestamp: parsed?.timestamp ?? new Date().toISOString(),
        source: 'client',
        level: parsed?.level ?? 'warn',
        releaseId: parsed?.releaseId ?? import.meta.env['VITE_COMMIT_HASH'] ?? 'dev',
        category: parsed?.category ?? 'LOG_FORWARD',
        message: parsed?.message ?? 'Oversized legacy client log',
        context: { truncated: true },
        ...getClientLogContext(),
      })
    );
  }
  return { line: normalized, bytes: byteLength(normalized) };
}

function enqueue(item: QueuedLine, front = false): void {
  if (item.bytes > MAX_QUEUE_BYTES) {
    droppedMessageCount++;
    return;
  }
  while (queuedBytes + item.bytes > MAX_QUEUE_BYTES && messageQueue.length > 0) {
    const dropped = messageQueue.shift();
    queuedBytes -= dropped?.bytes ?? 0;
    droppedMessageCount++;
  }
  if (front) {
    messageQueue.unshift(item);
  } else {
    messageQueue.push(item);
  }
  queuedBytes += item.bytes;
  if (droppedMessageCount % 100 === 1) {
    reportTransportFailure('Client log queue dropped records before delivery', {
      droppedMessageCount,
      queuedBytes,
    });
  }
}

function reportTransportFailure(message: string, context?: Record<string, unknown>): void {
  if (transportFailureReported) {
    return;
  }
  transportFailureReported = true;
  try {
    console.error(`[LOG_FORWARD] ${message}`, context ?? {});
  } catch {
    // A broken console must not interrupt gameplay.
  }
}

function clearHandshakeTimer(): void {
  if (handshakeTimer !== null) {
    clearTimeout(handshakeTimer);
    handshakeTimer = null;
  }
}

export function getLogsWebSocketUrl(): string {
  return logsWebSocketUrlFromGameplay(
    import.meta.env.VITE_WEBSOCKET_URL,
    location.host || location.hostname || 'localhost:3001',
    location.protocol === 'https:'
  );
}

function scheduleReconnect(): void {
  if (!isInitialized || reconnectTimer !== null) {
    return;
  }
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = null;
    connectWebSocket();
  }, RECONNECT_DELAY_MS);
}

function retireSocket(socket: WebSocket): void {
  if (ws !== socket) {
    return;
  }
  clearHandshakeTimer();
  ws = null;
  socket.onopen = null;
  socket.onerror = null;
  socket.onclose = null;
  try {
    socket.close();
  } catch (error) {
    reportTransportFailure('Failed to close retired log transport; reconnecting', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  scheduleReconnect();
}

function wirePayload(item: QueuedLine): string {
  const record = parseLogRecord(item.line);
  const context = getClientLogContext();
  return JSON.stringify({
    type: 'clientLog',
    timestamp: Date.now(),
    data: {
      sessionId: record?.sessionId ?? context.sessionId,
      level: record?.level ?? 'info',
      line: item.line,
      userAgent: navigator.userAgent,
      pageUrl: safePageUrl(),
    },
  });
}

function trySend(socket: WebSocket, item: QueuedLine): boolean {
  if (socket.bufferedAmount > MAX_SOCKET_BUFFERED_BYTES) {
    reportTransportFailure('Log transport backpressure; retaining records for reconnect', {
      bufferedBytes: socket.bufferedAmount,
    });
    retireSocket(socket);
    return false;
  }
  try {
    socket.send(wirePayload(item));
    transportFailureReported = false;
    return true;
  } catch (error) {
    reportTransportFailure('Failed to send client log; retaining it for reconnect', {
      error: error instanceof Error ? error.message : String(error),
    });
    retireSocket(socket);
    return false;
  }
}

function sendLossTelemetry(socket: WebSocket): boolean {
  if (droppedMessageCount === reportedDroppedMessageCount) {
    return true;
  }
  const item = normalizeLine(
    stringifyLogRecord(
      createLogRecord({
        timestamp: new Date().toISOString(),
        source: 'client',
        level: 'error',
        releaseId: import.meta.env['VITE_COMMIT_HASH'] ?? 'dev',
        category: 'STATE',
        message: 'Client log records dropped before delivery',
        context: {
          droppedRecords: droppedMessageCount,
          droppedSinceLastReport: droppedMessageCount - reportedDroppedMessageCount,
        },
        ...getClientLogContext(),
      })
    )
  );
  if (!trySend(socket, item)) {
    return false;
  }
  reportedDroppedMessageCount = droppedMessageCount;
  return true;
}

function flushQueue(socket: WebSocket): void {
  while (ws === socket && socket.readyState === WebSocket.OPEN && messageQueue.length > 0) {
    const item = messageQueue[0];
    if (!item || !trySend(socket, item)) {
      return;
    }
    messageQueue.shift();
    queuedBytes -= item.bytes;
  }
}

function connectWebSocket(): void {
  if (ws?.readyState === WebSocket.OPEN || ws?.readyState === WebSocket.CONNECTING) {
    return;
  }
  if (ws) {
    retireSocket(ws);
  }

  try {
    const socket = new WebSocket(getLogsWebSocketUrl());
    ws = socket;
    handshakeTimer = window.setTimeout(() => {
      if (ws === socket && socket.readyState === WebSocket.CONNECTING) {
        reportTransportFailure('Log transport handshake timed out; retaining queued records');
        retireSocket(socket);
      }
    }, HANDSHAKE_TIMEOUT_MS);
    socket.onopen = () => {
      if (ws === socket) {
        clearHandshakeTimer();
        transportFailureReported = false;
        if (sendLossTelemetry(socket)) {
          flushQueue(socket);
        }
      }
    };
    socket.onclose = (event) => {
      if (ws !== socket) {
        return;
      }
      clearHandshakeTimer();
      ws = null;
      reportTransportFailure('Log transport disconnected', {
        code: event.code,
        reason: event.reason,
      });
      scheduleReconnect();
    };
    socket.onerror = () => {
      if (ws === socket) {
        reportTransportFailure(
          'Log transport socket error; retaining queued records for reconnect'
        );
        retireSocket(socket);
      }
    };
  } catch (error) {
    clearHandshakeTimer();
    ws = null;
    reportTransportFailure('Failed to create log transport', {
      error: error instanceof Error ? error.message : String(error),
    });
    scheduleReconnect();
  }
}

export function startClientLogForwarder(): void {
  if (isInitialized) {
    return;
  }
  isInitialized = true;
  connectWebSocket();
}

export function stopClientLogForwarder(): void {
  isInitialized = false;
  clearHandshakeTimer();
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (ws) {
    const socket = ws;
    ws = null;
    socket.onopen = null;
    socket.onerror = null;
    socket.onclose = null;
    try {
      socket.close();
    } catch (error) {
      reportTransportFailure(
        'Failed to close log transport during stop; discarding queued records',
        {
          error: error instanceof Error ? error.message : String(error),
        }
      );
    }
  }
  messageQueue = [];
  queuedBytes = 0;
  reportedDroppedMessageCount = droppedMessageCount;
}

export function forwardLogToServer(line: string): void {
  const item = normalizeLine(line);
  const socket = ws;
  if (!socket || socket.readyState !== WebSocket.OPEN || !trySend(socket, item)) {
    enqueue(item);
  }
}
