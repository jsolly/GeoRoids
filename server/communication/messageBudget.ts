import type { WebSocket } from 'ws';

/**
 * A gameplay client sends one pose per client frame (~60 Hz) plus occasional
 * shoot, ability and chat messages. These token-bucket defaults sustain that
 * with roughly a 50% headroom and a two-second burst, so an honest client is
 * never throttled while a flood is cut off before it can load the single game
 * loop. The 64 KiB per-message cap in `createServer` bounds one message; this
 * bounds their rate and aggregate size per connection.
 */
export const GAMEPLAY_MESSAGE_BUDGET = {
  messagesPerSecond: 90,
  messageBurst: 180,
  bytesPerSecond: 96 * 1024,
  byteBurst: 256 * 1024,
} as const;

interface Bucket {
  messages: number;
  bytes: number;
  at: number;
  /** Set once the socket is first refused, so a flood counts as one disconnect. */
  refused: boolean;
}

interface GameplayMessageBudgetDiagnostics {
  /** Messages refused because a connection outran its budget. */
  rejected: number;
  /** Connections closed for exceeding the budget (one per offending socket). */
  disconnected: number;
}

/**
 * Per-connection token bucket for inbound `/ws` gameplay messages. One refused
 * message ends that connection, so `rejected` and `disconnected` move together
 * unless the caller keeps sending after the close.
 */
export class GameplayMessageBudget {
  private readonly buckets = new WeakMap<WebSocket, Bucket>();
  private readonly config: typeof GAMEPLAY_MESSAGE_BUDGET;
  private readonly now: () => number;
  private rejected = 0;
  private disconnected = 0;

  constructor(
    options: {
      config?: typeof GAMEPLAY_MESSAGE_BUDGET;
      now?: () => number;
    } = {}
  ) {
    this.config = options.config ?? GAMEPLAY_MESSAGE_BUDGET;
    this.now = options.now ?? Date.now;
  }

  /** Charge one message of `byteLength` to `socket`. Returns whether it fits the budget. */
  admit(socket: WebSocket, byteLength: number): 'ok' | 'rate-limited' {
    const now = this.now();
    const bucket = this.buckets.get(socket) ?? {
      messages: this.config.messageBurst,
      bytes: this.config.byteBurst,
      at: now,
      refused: false,
    };
    const elapsedSeconds = Math.max(0, now - bucket.at) / 1000;
    bucket.at = now;
    bucket.messages = Math.min(
      this.config.messageBurst,
      bucket.messages + elapsedSeconds * this.config.messagesPerSecond
    );
    bucket.bytes = Math.min(
      this.config.byteBurst,
      bucket.bytes + elapsedSeconds * this.config.bytesPerSecond
    );
    const bytes = Math.max(0, byteLength);
    if (bucket.messages < 1 || bucket.bytes < bytes) {
      this.rejected++;
      if (!bucket.refused) {
        bucket.refused = true;
        this.disconnected++;
      }
      this.buckets.set(socket, bucket);
      return 'rate-limited';
    }
    bucket.messages -= 1;
    bucket.bytes -= bytes;
    this.buckets.set(socket, bucket);
    return 'ok';
  }

  diagnostics(): GameplayMessageBudgetDiagnostics {
    return { rejected: this.rejected, disconnected: this.disconnected };
  }
}
