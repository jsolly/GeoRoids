export const GAMEPLAY_CONNECTIONS_PER_WINDOW = 50;
export const LOG_CONNECTIONS_PER_WINDOW = 6;
export const CONNECTION_ADMISSION_WINDOW_MS = 60_000;
/** Joins beyond this many live pilots are refused before an actor exists. */
export const MAX_PLAYERS = 100;
/**
 * Ceiling across every address in a lane, so an address the server cannot tell
 * apart — a spoofed `X-Real-IP`, or ingress that stops supplying one — cannot
 * buy unlimited budget by looking like many clients.
 *
 * Sized for the worst honest case rather than guessed: a deploy or a stall
 * re-upgrades the whole fleet at once, and a client that sees six seconds of
 * silence retries on a 0.5/1/2/4/8 s ladder, so MAX_PLAYERS pilots can
 * legitimately spend about 100 x 5 upgrades inside one window. 600 clears that
 * with headroom while still bounding one caller to a small multiple of a single
 * client's budget. Logs are a diagnostic lane and stay far tighter.
 */
export const GAMEPLAY_CONNECTIONS_PER_WINDOW_ALL = 600;
export const LOG_CONNECTIONS_PER_WINDOW_ALL = 60;

export function connectionLimitsDisabled(env: {
  nodeEnv: string;
  processNodeEnv?: string;
  vitest?: string;
}): boolean {
  const isTest = env.nodeEnv === 'test' || env.vitest === 'true' || env.processNodeEnv === 'test';
  const isDevelopment = env.nodeEnv === 'development' || env.processNodeEnv === 'development';
  return isTest || isDevelopment;
}

type ConnectionLane = 'gameplay' | 'logs';

interface ConnectionAdmissionDecision {
  accepted: boolean;
  lane: ConnectionLane;
  /** First rejection in this window. Later rejects stay quiet so a flap cannot warn per socket. */
  firstRejection: boolean;
  count: number;
  limit: number;
  /** True when the lane ceiling refused this, not the caller's own budget. */
  laneExhausted: boolean;
}

interface Bucket {
  count: number;
  lastAttempt: number;
  rejected: boolean;
}

/**
 * Gameplay and log upgrades spend separate per-address budgets.
 * A /logs flap must not close the next /ws join.
 */
export function createConnectionAdmission(disabled: boolean) {
  const buckets = new Map<string, Bucket>();
  const laneTotals = new Map<string, Bucket>();

  /** The live bucket for this window, or undefined when the window has rolled. */
  function live(store: Map<string, Bucket>, key: string, now: number): Bucket | undefined {
    const existing = store.get(key);
    if (!existing || now - existing.lastAttempt > CONNECTION_ADMISSION_WINDOW_MS) {
      return undefined;
    }
    return existing;
  }

  function charge(
    store: Map<string, Bucket>,
    key: string,
    bucket: Bucket | undefined,
    now: number
  ) {
    if (bucket) {
      bucket.count += 1;
      bucket.lastAttempt = now;
      return;
    }
    store.set(key, { count: 1, lastAttempt: now, rejected: false });
  }

  return {
    admit(ip: string, pathname: string, now: number): ConnectionAdmissionDecision {
      const lane: ConnectionLane = pathname === '/logs' ? 'logs' : 'gameplay';
      const limit = lane === 'logs' ? LOG_CONNECTIONS_PER_WINDOW : GAMEPLAY_CONNECTIONS_PER_WINDOW;
      const laneLimit =
        lane === 'logs' ? LOG_CONNECTIONS_PER_WINDOW_ALL : GAMEPLAY_CONNECTIONS_PER_WINDOW_ALL;
      if (disabled) {
        return {
          accepted: true,
          lane,
          firstRejection: false,
          count: 0,
          limit,
          laneExhausted: false,
        };
      }
      const key = `${lane}:${ip}`;
      const own = live(buckets, key, now);
      const all = live(laneTotals, lane, now);
      // Both budgets are read before either is charged, so a caller is never
      // billed for an upgrade the lane ceiling went on to refuse.
      if (own && own.count >= limit) {
        const firstRejection = !own.rejected;
        own.rejected = true;
        return {
          accepted: false,
          lane,
          firstRejection,
          count: own.count,
          limit,
          laneExhausted: false,
        };
      }
      if (all && all.count >= laneLimit) {
        const firstRejection = !all.rejected;
        all.rejected = true;
        return {
          accepted: false,
          lane,
          firstRejection,
          count: all.count,
          limit: laneLimit,
          laneExhausted: true,
        };
      }
      charge(buckets, key, own, now);
      charge(laneTotals, lane, all, now);
      return {
        accepted: true,
        lane,
        firstRejection: false,
        count: own ? own.count : 1,
        limit,
        laneExhausted: false,
      };
    },
    prune(now: number): void {
      for (const store of [buckets, laneTotals]) {
        for (const [key, bucket] of store) {
          if (now - bucket.lastAttempt > CONNECTION_ADMISSION_WINDOW_MS) {
            store.delete(key);
          }
        }
      }
    },
  };
}
