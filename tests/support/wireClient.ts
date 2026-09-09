import { once } from 'node:events';
import { type RawData, WebSocket } from 'ws';

export const WIRE_TIMEOUT_MS = 2_000;

export type WirePayload = Record<string, unknown>;

export type WireMessage = {
  type: string;
  data?: unknown;
};

function isRecord(value: unknown): value is WirePayload {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function decodeMessage(raw: RawData): WireMessage {
  const parsed: unknown = JSON.parse(String(raw));
  if (!isRecord(parsed)) {
    throw new Error('Server message must be an object');
  }
  const type = parsed['type'];
  if (typeof type !== 'string') {
    throw new Error('Server message type must be a string');
  }
  return {
    type,
    ...(Object.hasOwn(parsed, 'data') ? { data: parsed['data'] } : {}),
  };
}

export class WireClient {
  readonly messages: WireMessage[] = [];
  readonly failures: Error[] = [];

  constructor(readonly ws: WebSocket) {
    ws.on('error', (error) => {
      this.failures.push(error instanceof Error ? error : new Error(String(error)));
    });
    ws.on('message', (raw) => {
      try {
        this.messages.push(decodeMessage(raw));
      } catch (error) {
        this.failures.push(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async open(): Promise<void> {
    await once(this.ws, 'open', { signal: AbortSignal.timeout(WIRE_TIMEOUT_MS) });
    this.assertHealthy();
  }

  send(message: WirePayload): void {
    if (this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('Cannot send on a closed gameplay socket');
    }
    this.ws.send(JSON.stringify(message));
  }

  async barrier(): Promise<void> {
    this.assertHealthy();
    const pong = once(this.ws, 'pong', { signal: AbortSignal.timeout(WIRE_TIMEOUT_MS) });
    this.ws.ping();
    await pong;
    this.assertHealthy();
  }

  async close(): Promise<void> {
    if (this.ws.readyState === WebSocket.CLOSED) {
      return;
    }
    const closed = once(this.ws, 'close', { signal: AbortSignal.timeout(WIRE_TIMEOUT_MS) });
    this.ws.close();
    await closed;
  }

  mark(): number {
    return this.messages.length;
  }

  resetMessages(): void {
    this.messages.length = 0;
  }

  assertHealthy(): void {
    const failure = this.failures[0];
    if (failure) {
      throw failure;
    }
  }
}
