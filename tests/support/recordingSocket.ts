import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';

interface RecordedMessage {
  type: string;
  data?: unknown;
  timestamp?: number;
}

type SendCallback = (error?: Error) => void;
type SendOptions = {
  mask?: boolean;
  binary?: boolean;
  compress?: boolean;
  fin?: boolean;
};
type SendData = Parameters<WebSocket['send']>[0];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function messageFromJson(raw: string): RecordedMessage {
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed) || typeof parsed['type'] !== 'string') {
    throw new Error('RecordingSocket.send received a message without a string type');
  }
  const data = parsed['data'];
  const timestamp = parsed['timestamp'];
  if (timestamp !== undefined && typeof timestamp !== 'number') {
    throw new Error('RecordingSocket.send received a message with invalid timestamp');
  }
  return {
    type: parsed['type'],
    ...(data === undefined ? {} : { data }),
    ...(timestamp === undefined ? {} : { timestamp }),
  };
}

/** A typed in-process WebSocket boundary for server and entity unit tests. */
export class RecordingSocket extends EventEmitter implements WebSocket {
  binaryType: 'nodebuffer' | 'arraybuffer' | 'fragments' = 'nodebuffer';
  bufferedAmount = 0;
  readonly extensions = '';
  readonly isPaused = false;
  readonly protocol = '';
  readonly url = 'ws://unit.invalid';
  readonly CONNECTING = WebSocket.CONNECTING;
  readonly OPEN = WebSocket.OPEN;
  readonly CLOSING = WebSocket.CLOSING;
  readonly CLOSED = WebSocket.CLOSED;
  onopen: ((event: WebSocket.Event) => void) | null = null;
  onerror: ((event: WebSocket.ErrorEvent) => void) | null = null;
  onclose: ((event: WebSocket.CloseEvent) => void) | null = null;
  onmessage: ((event: WebSocket.MessageEvent) => void) | null = null;
  readonly sent: string[] = [];
  readonly inbox: RecordedMessage[] = [];
  private socketState: WebSocket['readyState'] = WebSocket.OPEN;

  get readyState(): WebSocket['readyState'] {
    return this.socketState;
  }

  send(data: SendData, callback?: SendCallback): void;
  send(data: SendData, options: SendOptions, callback?: SendCallback): void;
  send(
    data: SendData,
    optionsOrCallback?: SendOptions | SendCallback,
    callback?: SendCallback
  ): void {
    if (typeof optionsOrCallback === 'object') {
      throw new Error('RecordingSocket.send options are unsupported');
    }
    const done = optionsOrCallback ?? callback;
    if (typeof data !== 'string') {
      const error = new Error('RecordingSocket.send only supports string data');
      if (done) {
        done(error);
        return;
      }
      throw error;
    }
    if (this.readyState !== WebSocket.OPEN) {
      const error = new Error('RecordingSocket.send requires an open socket');
      if (done) {
        done(error);
        return;
      }
      throw error;
    }
    this.sent.push(data);
    const message = messageFromJson(data);
    this.inbox.push(message);
    done?.();
  }

  close(code = 1000, data: string | Buffer = ''): void {
    if (this.readyState === WebSocket.CLOSED) {
      return;
    }
    this.socketState = WebSocket.CLOSING;
    const reason = typeof data === 'string' ? data : data.toString();
    this.socketState = WebSocket.CLOSED;
    const event: WebSocket.CloseEvent = {
      wasClean: true,
      code,
      reason,
      type: 'close',
      target: this,
    };
    this.emit('close', code, Buffer.from(reason));
    this.onclose?.(event);
  }

  received(type: string): RecordedMessage[] {
    return this.inbox.filter((message) => message.type === type);
  }

  lastReceived(type: string): RecordedMessage | undefined {
    return this.received(type).at(-1);
  }

  clear(): void {
    this.sent.length = 0;
    this.inbox.length = 0;
  }

  ping(..._args: unknown[]): void {
    this.unsupported('ping');
  }

  pong(..._args: unknown[]): void {
    this.unsupported('pong');
  }

  terminate(): void {
    this.unsupported('terminate');
  }

  pause(): void {
    this.unsupported('pause');
  }

  resume(): void {
    this.unsupported('resume');
  }

  addEventListener<K extends keyof WebSocket.WebSocketEventMap>(
    _type: K,
    _listener:
      | ((event: WebSocket.WebSocketEventMap[K]) => void)
      | { handleEvent(event: WebSocket.WebSocketEventMap[K]): void },
    _options?: WebSocket.EventListenerOptions
  ): void {
    this.unsupported('addEventListener');
  }

  removeEventListener<K extends keyof WebSocket.WebSocketEventMap>(
    _type: K,
    _listener:
      | ((event: WebSocket.WebSocketEventMap[K]) => void)
      | { handleEvent(event: WebSocket.WebSocketEventMap[K]): void }
  ): void {
    this.unsupported('removeEventListener');
  }

  private unsupported(operation: string): never {
    throw new Error(`RecordingSocket.${operation} is unsupported in this fixture`);
  }
}
