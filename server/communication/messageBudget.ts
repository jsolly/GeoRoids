import type { WebSocket } from 'ws';

/**
 * A gameplay client sends one pose per client frame (~60 Hz) plus occasional
 * shoot, ability and chat messages. These token-bucket defaults sustain that
 * with roughly a 50% headroom, and the burst covers a full backlog flush: the
 * client keeps sampling poses on a fixed 60 Hz timer while its link is stalled
 * and only gives up after 6 s (`CONNECTION_STALE_TIMEOUT_MS`), so TCP can
 * deliver up to ~360 buffered poses in one read on recovery. The burst is
 * sized past that (8 s of poses) so an honest reconnecting client is never
 * throttled, while a sustained flood is still cut off before it can load the
 * single game loop. The 64 KiB per-message cap in `createServer` bounds one
 * message; this bounds their rate and aggregate size per connection.
 */
export const GAMEPLAY_MESSAGE_BUDGET = {
  messagesPerSecond: 90,
  messageBurst: 480,
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
 * Per-connection token bucket for inbound `/ws` gameplay messages. The first
 * over-budget message returns `rate-limited` (the caller drops the connection);
 * any further message from the same socket returns `closed` so the caller can
 * ignore it silently instead of logging and scanning once per flooded frame
 * while the socket tears down.
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

  /**
   * Charge one message of `byteLength` to `socket`: `ok` if it fits,
   * `rate-limited` on the first over-budget message (close the socket now),
   * `closed` for later over-budget messages from an already-refused socket.
   */
  admit(socket: WebSocket, byteLength: number): 'ok' | 'rate-limited' | 'closed' {
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
      const firstRefusal = !bucket.refused;
      bucket.refused = true;
      this.buckets.set(socket, bucket);
      if (firstRefusal) {
        this.disconnected++;
        return 'rate-limited';
      }
      return 'closed';
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
