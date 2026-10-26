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
 * What the shared unattributed bucket may spend, per lane.
 *
 * Sized to the whole fleet's worst honest demand, because that is exactly the
 * case the bucket exists for: ingress stops supplying `X-Real-IP` and every
 * pilot collapses onto this one key, so a full fleet must still be able to
 * rejoin and keep forwarding records. A pilot's own budget already bounds its
 * share of that, so the product is the honest ceiling rather than a guess.
 *
 * There is deliberately no ceiling across all addresses. An earlier revision
 * added one and gave this bucket the whole of it, which made the key a caller
 * can select for itself the cheapest way to close the lane for everyone:
 * independent review reproduced one source refusing 488 of 600 honest joins
 * from a single machine with no address rotation, indefinitely. The same
 * ceiling also refused honest callers who were inside their own budget, in
 * both lanes, because the sums of the per-address budgets a full fleet holds
 * are larger than any ceiling that was tight enough to be worth having.
 * Bounding a lane in aggregate without handing out that lever needs a design
 * this change does not have; `main` has no aggregate bound either, so leaving
 * it out is no weaker than today.
 */
export const UNATTRIBUTED_GAMEPLAY_CONNECTIONS_PER_WINDOW =
  MAX_PLAYERS * WORST_HONEST_UPGRADES_PER_PILOT;
export const UNATTRIBUTED_LOG_CONNECTIONS_PER_WINDOW = MAX_PLAYERS * LOG_CONNECTIONS_PER_WINDOW;

/**
 * The address charged when the edge cannot tell callers apart.
 *
 * Such traffic shares one fleet-sized budget instead of one pilot's. Squeezing
 * a whole fleet through a single per-address bucket is the lockout this limiter
 * exists to prevent, so ingress that stops supplying `X-Real-IP` has to degrade
 * to "the fleet shares a fleet-sized budget" rather than to "half the pilots are
 * refused" — which is what charging them all to the proxy's own address did.
 *
 * A caller can put itself in this bucket by withholding or mangling the header,
 * so its budget bounds only itself: it is never the whole of some larger limit
 * that attributable callers also answer to.
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
}

interface Bucket {
  count: number;
  /**
   * When this window opened. A charge never moves it, so the window is fixed.
   *
   * Anchoring this to the last attempt instead turns a per-window budget into a
   * lifetime one: a caller that keeps trying never rolls its own window, so a
   * pilot flapping through a bad connection spends its 50 and is then refused
   * until it stays quiet for a whole window -- which is the lockout this
   * limiter exists to prevent, reached from the other direction.
   */
  windowStart: number;
  rejected: boolean;
}

/**
 * Gameplay and log upgrades spend separate per-address budgets.
 * A /logs flap must not close the next /ws join.
 */
export function createConnectionAdmission(disabled: boolean) {
  const buckets = new Map<string, Bucket>();

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
    return { count: 0, windowStart: now, rejected: false };
  }

  function charge(store: Map<string, Bucket>, key: string, bucket: Bucket): void {
    bucket.count += 1;
    store.set(key, bucket);
  }

  return {
    admit(ip: string, pathname: string, now: number): ConnectionAdmissionDecision {
      const lane: ConnectionLane = pathname === '/logs' ? 'logs' : 'gameplay';
      // The shared bucket gets a fleet-sized budget of its own, not a share of
      // anything attributable callers also spend; see UNATTRIBUTED_CLIENT.
      const limit =
        ip === UNATTRIBUTED_CLIENT
          ? lane === 'logs'
            ? UNATTRIBUTED_LOG_CONNECTIONS_PER_WINDOW
            : UNATTRIBUTED_GAMEPLAY_CONNECTIONS_PER_WINDOW
          : lane === 'logs'
            ? LOG_CONNECTIONS_PER_WINDOW
            : GAMEPLAY_CONNECTIONS_PER_WINDOW;
      if (disabled) {
        return { accepted: true, lane, firstRejection: false, count: 0, limit };
      }
      const key = `${lane}:${ip}`;
      const own = bucketFor(buckets, key, now);
      // The budget is read before it is charged, so a refused upgrade is never
      // billed and never moves a window.
      if (own.count >= limit) {
        const firstRejection = !own.rejected;
        own.rejected = true;
        return { accepted: false, lane, firstRejection, count: own.count, limit };
      }
      charge(buckets, key, own);
      return { accepted: true, lane, firstRejection: false, count: own.count, limit };
    },
    /**
     * Drops buckets whose window has rolled, so the map stays bounded. What
     * matters is that it never resets a budget still being spent, which the
     * same comparison that expires a window already decides.
     *
     * An earlier revision kept a second timestamp for this, on the theory that
     * pruning on the window start could evict a caller mid-window. It cannot:
     * a bucket this deletes has rolled, so `bucketFor` would hand that caller a
     * fresh one anyway and its count is stale either way. The two are therefore
     * indistinguishable through `admit`, no test can tell them apart, and one
     * timestamp is the honest shape.
     */
    prune(now: number): void {
      for (const [key, bucket] of buckets) {
        if (now - bucket.windowStart > CONNECTION_ADMISSION_WINDOW_MS) {
          buckets.delete(key);
        }
      }
    },
    /** Live bucket count, so `prune` has something to assert against. */
    size(): number {
      return buckets.size;
    },
  };
}
