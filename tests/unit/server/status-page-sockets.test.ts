import { type DOMWindow, JSDOM } from 'jsdom';
import { expect, test } from 'vitest';
import { renderStatusPage } from '../../../server/statusPage';

type SocketEvent = {
  code: number;
  reason: string;
};

type SocketHandler = (event: unknown) => void;

class StatusPageSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  private static readonly attempts = new Map<'game' | 'logs', number>();
  private static throwNextSend = false;

  static reset(): void {
    StatusPageSocket.attempts.clear();
    StatusPageSocket.throwNextSend = false;
  }

  static failNextSend(): void {
    StatusPageSocket.throwNextSend = true;
  }

  readonly url: string;
  readyState = StatusPageSocket.CONNECTING;
  onopen: SocketHandler | null = null;
  onclose: ((event: SocketEvent) => void) | null = null;
  onerror: SocketHandler | null = null;
  onmessage: SocketHandler | null = null;

  constructor(url: string) {
    this.url = url;
    const kind = url.includes('/ws') ? 'game' : 'logs';
    const attempt = (StatusPageSocket.attempts.get(kind) ?? 0) + 1;
    StatusPageSocket.attempts.set(kind, attempt);

    if (kind === 'game' && attempt === 1) {
      return;
    }

    queueMicrotask(() => {
      if (this.readyState !== StatusPageSocket.CONNECTING) {
        return;
      }
      if (kind === 'logs' && attempt === 1) {
        this.readyState = StatusPageSocket.CLOSED;
        this.onclose?.({ code: 1006, reason: 'pre-open test close' });
        return;
      }
      this.readyState = StatusPageSocket.OPEN;
      this.onopen?.({});
    });
  }

  send(data: string): void {
    if (this.readyState !== StatusPageSocket.OPEN) {
      throw new Error('socket is not open');
    }
    if (StatusPageSocket.throwNextSend) {
      StatusPageSocket.throwNextSend = false;
      throw new Error('simulated send race');
    }
    void data;
  }

  close(): void {
    if (this.readyState === StatusPageSocket.CLOSED) {
      return;
    }
    this.readyState = StatusPageSocket.CLOSING;
    queueMicrotask(() => {
      if (this.readyState === StatusPageSocket.CLOSED) {
        return;
      }
      this.readyState = StatusPageSocket.CLOSED;
      this.onclose?.({ code: 1000, reason: 'closed by test' });
    });
  }
}

type ScheduledTimer = {
  callback: () => void;
  delay: number;
};

function createStatusDocument(): {
  advanceTimers: (maximumDelay: number) => void;
  pendingTimers: () => number;
  dispose: () => void;
  window: DOMWindow;
} {
  const timers = new Map<number, ScheduledTimer>();
  let nextTimerId = 1;
  const dom = new JSDOM(renderStatusPage(false), {
    runScripts: 'dangerously',
    url: 'http://status.test/status',
    beforeParse(window) {
      Object.defineProperty(window, 'WebSocket', {
        configurable: true,
        value: StatusPageSocket,
      });
      Object.defineProperty(window, 'fetch', {
        configurable: true,
        value: () =>
          Promise.resolve({
            ok: true,
            json: async () => ({
              players: 0,
              status: 'healthy',
              timestamp: '2026-01-01T00:00:00.000Z',
              uptime: 1,
            }),
          }),
      });
      Object.defineProperty(window, 'setTimeout', {
        configurable: true,
        value: (callback: () => void, delay = 0): number => {
          const timerId = nextTimerId++;
          timers.set(timerId, { callback, delay });
          return timerId;
        },
      });
      Object.defineProperty(window, 'clearTimeout', {
        configurable: true,
        value: (timerId: number): void => {
          timers.delete(timerId);
        },
      });
      Object.defineProperty(window, 'setInterval', {
        configurable: true,
        value: (_callback: () => void, _delay = 0): number => 0,
      });
      if (typeof window.AbortSignal.timeout !== 'function') {
        Object.defineProperty(window.AbortSignal, 'timeout', {
          configurable: true,
          value: () => new window.AbortController().signal,
        });
      }
    },
  });

  return {
    pendingTimers: () => timers.size,
    advanceTimers(maximumDelay) {
      for (const [timerId, timer] of Array.from(timers.entries())) {
        if (timer.delay <= maximumDelay) {
          timers.delete(timerId);
          timer.callback();
        }
      }
    },
    dispose() {
      timers.clear();
      dom.window.close();
    },
    window: dom.window,
  };
}

function button(window: DOMWindow, id: string): HTMLButtonElement {
  const element = window.document.getElementById(id);
  if (!(element instanceof window.HTMLButtonElement)) {
    throw new Error(`Missing status button ${id}`);
  }
  return element;
}

function text(window: DOMWindow, id: string): string {
  return window.document.getElementById(id)?.textContent ?? '';
}

async function settleMicrotasks(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test('status sockets time out, retry after pre-open close, and expose send races while restoring controls', async () => {
  StatusPageSocket.reset();
  const status = createStatusDocument();
  try {
    await settleMicrotasks();

    const connectGame = button(status.window, 'connectGameBtn');
    connectGame.click();
    expect(connectGame.disabled).toBe(true);
    expect(button(status.window, 'disconnectGameBtn').disabled).toBe(false);
    connectGame.dispatchEvent(new status.window.Event('click'));
    expect(text(status.window, 'messageLog')).toContain('Game WebSocket is already connecting');
    status.advanceTimers(5000);
    expect(text(status.window, 'messageLog')).toContain(
      'Game WebSocket failed: connection timed out after 5 seconds'
    );
    expect(connectGame.disabled).toBe(false);
    expect(button(status.window, 'disconnectGameBtn').disabled).toBe(true);

    connectGame.click();
    await settleMicrotasks();
    expect(text(status.window, 'gameStatus')).toBe('Connected');
    expect(button(status.window, 'disconnectGameBtn').disabled).toBe(false);

    const connectLogs = button(status.window, 'connectLogsBtn');
    connectLogs.click();
    await settleMicrotasks();
    expect(text(status.window, 'messageLog')).toContain(
      'Log WebSocket failed: closed before opening (1006 - pre-open test close)'
    );
    expect(connectLogs.disabled).toBe(false);
    expect(button(status.window, 'disconnectLogsBtn').disabled).toBe(true);

    connectLogs.click();
    await settleMicrotasks();
    expect(text(status.window, 'logStatus')).toBe('Connected');
    expect(button(status.window, 'testLogBtn').disabled).toBe(false);

    StatusPageSocket.failNextSend();
    button(status.window, 'testLogBtn').click();
    expect(text(status.window, 'messageLog')).toContain(
      'Log WebSocket failed: failed to send test log message: simulated send race'
    );
    expect(text(status.window, 'logStatus')).toBe('Disconnected');
    expect(connectLogs.disabled).toBe(false);

    connectLogs.click();
    await settleMicrotasks();
    StatusPageSocket.failNextSend();
    const clientLog = button(status.window, 'clientLogBtn');
    clientLog.click();
    await settleMicrotasks();
    expect(text(status.window, 'messageLog')).toContain(
      'Failed to send log message: send failed: simulated send race'
    );
    expect(clientLog.disabled).toBe(false);
  } finally {
    status.dispose();
  }
});

test.each([
  {
    kind: 'Game',
    connect: 'connectGameBtn',
    disconnect: 'disconnectGameBtn',
    status: 'gameStatus',
  },
  { kind: 'Log', connect: 'connectLogsBtn', disconnect: 'disconnectLogsBtn', status: 'logStatus' },
])('canceling a pending $kind connection clears its deadline and immediately permits retry', async (controls) => {
  StatusPageSocket.reset();
  const status = createStatusDocument();
  try {
    await settleMicrotasks();
    const timersBefore = status.pendingTimers();
    const connect = button(status.window, controls.connect);
    connect.click();
    expect(status.pendingTimers()).toBe(timersBefore + 1);
    button(status.window, controls.disconnect).click();
    expect(connect.disabled).toBe(false);
    expect(button(status.window, controls.disconnect).disabled).toBe(true);
    expect(text(status.window, controls.status)).toBe('Disconnected');
    expect(status.pendingTimers()).toBe(timersBefore);
    await settleMicrotasks();
    status.advanceTimers(5000);
    expect(text(status.window, 'messageLog')).toContain(
      `${controls.kind} WebSocket disconnected by operator`
    );
    expect(text(status.window, 'messageLog')).not.toContain('WebSocket failed');
    const timersBeforeRetry = status.pendingTimers();
    connect.click();
    await settleMicrotasks();
    expect(text(status.window, controls.status)).toBe('Connected');
    expect(status.pendingTimers()).toBe(timersBeforeRetry);
  } finally {
    status.dispose();
  }
});
