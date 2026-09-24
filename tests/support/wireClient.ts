import { once } from 'node:events';
import { WebSocket } from 'ws';

const WIRE_TIMEOUT_MS = 2_000;

type WirePayload = Record<string, unknown>;

export type WireMessage = {
  type: string;
  data?: unknown;
};

function isRecord(value: unknown): value is WirePayload {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asWireError(value: unknown): Error {
  if (value instanceof Error) {
    return value;
  }
  if (typeof value === 'string') {
    return new Error(value);
  }
  return new Error(JSON.stringify(value));
}

function decodeMessage(raw: string | Buffer): WireMessage {
  const text = typeof raw === 'string' ? raw : raw.toString('utf8');
  const parsed: unknown = JSON.parse(text);
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
  readonly wireMessages: Array<{ readonly raw: string; readonly message: WireMessage }> = [];
  readonly failures: Error[] = [];

  constructor(readonly ws: WebSocket) {
    ws.on('error', (error) => {
      this.failures.push(asWireError(error));
    });
    ws.on('message', (raw) => {
      try {
        const text = typeof raw === 'string' ? raw : raw.toString('utf8');
        const message = decodeMessage(text);
        this.messages.push(message);
        this.wireMessages.push({ raw: text, message });
      } catch (error) {
        this.failures.push(asWireError(error));
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
    this.wireMessages.length = 0;
  }

  assertHealthy(): void {
    const failure = this.failures[0];
    if (failure) {
      throw failure;
    }
  }
}
