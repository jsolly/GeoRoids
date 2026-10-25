export const GAMEPLAY_CONNECTIONS_PER_WINDOW = 50;
export const LOG_CONNECTIONS_PER_WINDOW = 6;
export const CONNECTION_ADMISSION_WINDOW_MS = 60_000;
/** Joins beyond this many live pilots are refused before an actor exists. */
export const MAX_PLAYERS = 100;

/**
 * Worst honest demand from one pilot inside one window: the upgrade it makes
 * when its socket drops, plus every retry on the client's backoff ladder.
 *
 * `server/` may not import `src/`, so the step count is restated here and
 * pinned against the real `RECONNECT_DELAYS_MS` by a test that imports both.
 */
const RECONNECT_LADDER_STEPS = 5;
export const WORST_HONEST_UPGRADES_PER_PILOT = 1 + RECONNECT_LADDER_STEPS;

/**
 * Ceiling across every address in one lane, so a caller the edge cannot tell
 * apart — a spoofed `X-Real-IP`, or ingress that stops supplying one — cannot
 * buy unlimited budget by looking like many clients.
 *
 * Twice the worst honest case. An earlier revision set this to exactly that
 * case and described it as headroom, which it was not: a fleet-wide stall
 * costs `MAX_PLAYERS * WORST_HONEST_UPGRADES_PER_PILOT` upgrades, so 600 left
 * nothing spare, and the sizing arithmetic behind it counted the five retries
 * while forgetting the initial upgrade.
 */
export const GAMEPLAY_CONNECTIONS_PER_WINDOW_ALL =
  MAX_PLAYERS * WORST_HONEST_UPGRADES_PER_PILOT * 2;
/**
 * Diagnostics stay tighter than gameplay but are still fleet-sized: a deploy
 * or a stall makes every pilot forward a record, so honest demand starts at one
 * socket per pilot. An earlier revision used 60 — below `MAX_PLAYERS` — which
 * refused two fifths of a full fleet's telemetry at exactly the moment it was
 * worth reading, and did so on a limiter that had only just started.
 */
export const LOG_CONNECTIONS_PER_WINDOW_ALL = MAX_PLAYERS * 2;

/**
 * The address charged when the edge cannot tell callers apart.
 *
 * Such traffic answers to the lane ceiling instead of one address's budget.
 * Squeezing a whole fleet through a single per-address bucket is the lockout
 * this limiter exists to prevent, so ingress that stops supplying `X-Real-IP`
 * has to degrade to "everyone shares the lane" rather than to "half the pilots
 * are refused" — which is what charging them all to the proxy's own address
 * actually did.
 */
export const UNATTRIBUTED_CLIENT = 'unattributed';

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
  /**
   * When this window opened. A charge never moves it, so the window is fixed.
   *
   * Anchoring expiry to the last attempt instead made the lane bucket — which
   * every address charges — roll only after 60 s of server-wide silence, so a
   * per-window ceiling became a counter that accumulated over uptime and
   * periodically refused every pilot. Keep these two timestamps apart.
   */
  windowStart: number;
  /** Last attempt, for `prune` alone. */
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

  /**
   * The bucket for the window containing `now`. A rolled window yields a fresh
   * one, left unstored until something is charged to it, so refused attempts
   * never grow either map.
   */
  function bucketFor(store: Map<string, Bucket>, key: string, now: number): Bucket {
    const existing = store.get(key);
    if (existing && now - existing.windowStart <= CONNECTION_ADMISSION_WINDOW_MS) {
      return existing;
    }
    return { count: 0, windowStart: now, lastAttempt: now, rejected: false };
  }

  function charge(store: Map<string, Bucket>, key: string, bucket: Bucket, now: number): void {
    bucket.count += 1;
    bucket.lastAttempt = now;
    store.set(key, bucket);
  }

  return {
    admit(ip: string, pathname: string, now: number): ConnectionAdmissionDecision {
      const lane: ConnectionLane = pathname === '/logs' ? 'logs' : 'gameplay';
      const laneLimit =
        lane === 'logs' ? LOG_CONNECTIONS_PER_WINDOW_ALL : GAMEPLAY_CONNECTIONS_PER_WINDOW_ALL;
      // Unattributable callers answer to the lane ceiling alone; see UNATTRIBUTED_CLIENT.
      const limit =
        ip === UNATTRIBUTED_CLIENT
          ? laneLimit
          : lane === 'logs'
            ? LOG_CONNECTIONS_PER_WINDOW
            : GAMEPLAY_CONNECTIONS_PER_WINDOW;
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
      const own = bucketFor(buckets, key, now);
      const all = bucketFor(laneTotals, lane, now);
      // Both budgets are read before either is charged, so a refused upgrade is
      // never billed and never moves a window.
      if (own.count >= limit) {
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
      if (all.count >= laneLimit) {
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
        count: own.count,
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
