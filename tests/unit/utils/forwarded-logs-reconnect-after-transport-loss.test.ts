import { afterEach, expect, test, vi } from 'vitest';

vi.mock('../../../src/constants', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/constants')>();
  return {
    ...actual,
    LOGGING: { ...actual.LOGGING, WRITE_TO_CONSOLE: false, FORWARD_TO_SERVER: true },
  };
});

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readonly url: string;
  readyState = FakeWebSocket.CONNECTING;
  bufferedAmount = 0;
  sent: string[] = [];
  failNextSend = false;
  onopen: (() => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(message: string): void {
    if (this.failNextSend) {
      this.failNextSend = false;
      throw new Error('send failed');
    }
    this.sent.push(message);
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code: 1006, reason: 'test disconnect' });
  }
}

const originalGlobalWebSocket = globalThis.WebSocket;
const originalWindowWebSocket = window.WebSocket;

afterEach(() => {
  vi.useRealTimers();
  Object.defineProperty(globalThis, 'WebSocket', {
    configurable: true,
    writable: true,
    value: originalGlobalWebSocket,
  });
  Object.defineProperty(window, 'WebSocket', {
    configurable: true,
    writable: true,
    value: originalWindowWebSocket,
  });
});

test('the client log forwarder can reconnect after its first socket closes', async () => {
  vi.useFakeTimers();
  FakeWebSocket.instances = [];
  Object.defineProperty(globalThis, 'WebSocket', {
    configurable: true,
    writable: true,
    value: FakeWebSocket,
  });
  Object.defineProperty(window, 'WebSocket', {
    configurable: true,
    writable: true,
    value: FakeWebSocket,
  });

  const { startClientLogForwarder, stopClientLogForwarder } = await import(
    '../../../src/utils/logForwarder'
  );

  try {
    startClientLogForwarder();
    expect(FakeWebSocket.instances).toHaveLength(1);

    FakeWebSocket.instances[0]?.close();
    await vi.advanceTimersByTimeAsync(4999);
    expect(FakeWebSocket.instances).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(FakeWebSocket.instances).toHaveLength(2);
  } finally {
    stopClientLogForwarder();
  }
});

test('stopping before a log socket opens permits a fresh start', async () => {
  vi.useFakeTimers();
  FakeWebSocket.instances = [];
  Object.defineProperty(globalThis, 'WebSocket', {
    configurable: true,
    writable: true,
    value: FakeWebSocket,
  });
  Object.defineProperty(window, 'WebSocket', {
    configurable: true,
    writable: true,
    value: FakeWebSocket,
  });
  const { startClientLogForwarder, stopClientLogForwarder } = await import(
    '../../../src/utils/logForwarder'
  );
  try {
    startClientLogForwarder();
    expect(FakeWebSocket.instances).toHaveLength(1);
    stopClientLogForwarder();
    startClientLogForwarder();
    expect(FakeWebSocket.instances).toHaveLength(2);
  } finally {
    stopClientLogForwarder();
  }
});

test('a synchronous send failure retains the record for the reconnected socket', async () => {
  vi.useFakeTimers();
  FakeWebSocket.instances = [];
  Object.defineProperty(globalThis, 'WebSocket', {
    configurable: true,
    writable: true,
    value: FakeWebSocket,
  });
  Object.defineProperty(window, 'WebSocket', {
    configurable: true,
    writable: true,
    value: FakeWebSocket,
  });
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const { forwardLogToServer, startClientLogForwarder, stopClientLogForwarder } = await import(
    '../../../src/utils/logForwarder'
  );
  try {
    startClientLogForwarder();
    const first = FakeWebSocket.instances[0];
    if (!first) {
      throw new Error('Expected first log socket');
    }
    first.readyState = FakeWebSocket.OPEN;
    first.onopen?.();
    first.failNextSend = true;
    forwardLogToServer(
      '{"version":1,"timestamp":"2026-01-01T00:00:00.000Z","source":"client","level":"warn","releaseId":"test","message":"retained"}'
    );
    await vi.advanceTimersByTimeAsync(5000);
    const second = FakeWebSocket.instances[1];
    if (!second) {
      throw new Error('Expected replacement log socket');
    }
    second.readyState = FakeWebSocket.OPEN;
    second.onopen?.();
    expect(second.sent).toHaveLength(1);
    expect(second.sent[0]).toContain('retained');
    expect(warning).toHaveBeenCalledTimes(1);
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining('Failed to send client log'),
      expect.any(Object)
    );
  } finally {
    stopClientLogForwarder();
    warning.mockRestore();
  }
});

test('a stalled handshake reconnects and delivers the original queued record', async () => {
  vi.useFakeTimers();
  FakeWebSocket.instances = [];
  Object.defineProperty(globalThis, 'WebSocket', {
    configurable: true,
    writable: true,
    value: FakeWebSocket,
  });
  Object.defineProperty(window, 'WebSocket', {
    configurable: true,
    writable: true,
    value: FakeWebSocket,
  });
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const { forwardLogToServer, startClientLogForwarder, stopClientLogForwarder } = await import(
    '../../../src/utils/logForwarder'
  );
  try {
    startClientLogForwarder();
    forwardLogToServer(
      '{"version":1,"timestamp":"2026-01-01T00:00:00.000Z","source":"client","level":"warn","releaseId":"test","message":"queued during handshake"}'
    );
    await vi.advanceTimersByTimeAsync(15_000);
    const replacement = FakeWebSocket.instances[1];
    if (!replacement) {
      throw new Error('Expected replacement log socket');
    }
    replacement.readyState = FakeWebSocket.OPEN;
    replacement.onopen?.();
    expect(replacement.sent).toHaveLength(1);
    expect(replacement.sent[0]).toContain('queued during handshake');
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining('handshake timed out'),
      expect.any(Object)
    );
  } finally {
    stopClientLogForwarder();
    warning.mockRestore();
  }
});

test('browser queue overflow is bounded and reported before retained records', async () => {
  FakeWebSocket.instances = [];
  Object.defineProperty(globalThis, 'WebSocket', {
    configurable: true,
    writable: true,
    value: FakeWebSocket,
  });
  Object.defineProperty(window, 'WebSocket', {
    configurable: true,
    writable: true,
    value: FakeWebSocket,
  });
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const { forwardLogToServer, startClientLogForwarder, stopClientLogForwarder } = await import(
    '../../../src/utils/logForwarder'
  );
  try {
    startClientLogForwarder();
    const socket = FakeWebSocket.instances[0];
    if (!socket) {
      throw new Error('Expected log socket');
    }
    for (let index = 0; index < 200; index++) {
      forwardLogToServer(
        JSON.stringify({
          version: 1,
          timestamp: new Date().toISOString(),
          source: 'client',
          level: 'warn',
          releaseId: 'test',
          message: `${index}:${'x'.repeat(2000)}`,
        })
      );
    }
    socket.readyState = FakeWebSocket.OPEN;
    socket.onopen?.();

    const firstWireMessage = JSON.parse(socket.sent[0] ?? '{}');
    const lossRecord = JSON.parse(firstWireMessage.data?.line ?? '{}');
    expect(lossRecord).toMatchObject({
      source: 'client',
      level: 'warn',
      category: 'STATE',
      message: 'Client log records dropped before delivery',
    });
    expect(lossRecord.context?.droppedSinceLastReport).toBeGreaterThan(0);
    expect(socket.sent.length).toBeLessThan(200);
  } finally {
    stopClientLogForwarder();
    warning.mockRestore();
  }
});
