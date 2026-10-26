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
 * Both lanes use ONE rule: a full fleet times that lane's per-pilot budget. The
 * bucket exists for a fleet collapsed onto a single key by ingress that stopped
 * supplying `X-Real-IP`, so parity with the attributed regime is the only
 * sizing that keeps the degradation honest.
 *
 * An earlier revision sized the gameplay one from the retry ladder instead, and
 * the two lanes then derived their budgets by different rules. Independent
 * review reproduced the consequence: a full fleet whose pilots each drop twice
 * inside one window is admitted in full when attributed and loses exactly half
 * when not -- "half the pilots refused", which is the outcome this bucket is
 * supposed to prevent, reached in the lane that decides whether a pilot rejoins.
 */
export const UNATTRIBUTED_GAMEPLAY_CONNECTIONS_PER_WINDOW =
  MAX_PLAYERS * GAMEPLAY_CONNECTIONS_PER_WINDOW;
export const UNATTRIBUTED_LOG_CONNECTIONS_PER_WINDOW = MAX_PLAYERS * LOG_CONNECTIONS_PER_WINDOW;

/**
 * A backstop across every address in one lane. It exists for one job: to bound
 * what a bypass of per-address attribution can spend. It is NOT a fair-share
 * device and must never refuse an honest caller.
 *
 * Sized so it cannot: a full fleet's attributed demand is
 * `MAX_PLAYERS * <per-pilot budget>`, the shared bucket above may spend the
 * same again, and this is their sum. So the worst honest attributed fleet,
 * running at the same time as a fully spent shared bucket, still fits.
 *
 * An earlier revision had a ceiling and deleted it; both were wrong, for
 * reasons worth keeping:
 *
 * - As first shipped it was sized from the retry ladder
 *   (`MAX_PLAYERS * WORST_HONEST_UPGRADES_PER_PILOT * 2`), which is far BELOW
 *   the sum of the per-address budgets a full fleet actually holds. It
 *   therefore refused callers who were inside their own budget, and spending it
 *   became a denial of service: review reproduced one source refusing 488 of
 *   600 honest joins from a single machine. Sizing from the per-address budget
 *   rather than the ladder is what fixes that, and the relationship is pinned
 *   by a test rather than asserted here.
 * - Deleting it was justified with "`main` has no aggregate bound either". That
 *   was FALSE. On `main` the key is the socket peer, which behind Railway's
 *   edge is the proxy, so every caller shared ONE bucket and the whole internet
 *   got 50 accepted gameplay upgrades a minute between them. `main`'s aggregate
 *   bound is a side effect of the very bug this file now fixes, so re-keying to
 *   the real client removes it. Leaving it removed took the server-wide rate
 *   from hard-capped to uncapped.
 */
export const GAMEPLAY_CONNECTIONS_PER_WINDOW_ALL =
  MAX_PLAYERS * GAMEPLAY_CONNECTIONS_PER_WINDOW + UNATTRIBUTED_GAMEPLAY_CONNECTIONS_PER_WINDOW;
export const LOG_CONNECTIONS_PER_WINDOW_ALL =
  MAX_PLAYERS * LOG_CONNECTIONS_PER_WINDOW + UNATTRIBUTED_LOG_CONNECTIONS_PER_WINDOW;

/**
 * How many live per-address buckets the limiter will hold.
 *
 * Re-keying from the socket peer to the forwarded address made this map
 * attacker-diverse: on `main` it held one key per edge proxy, here it holds one
 * per claimed client. `/logs` upgrades reach `admit` with no auth and no
 * completed handshake, so without a bound a caller presenting distinct
 * addresses -- an IPv6 /64 routed to one host is the ordinary case -- grows it
 * without limit and exhausts the container. Measured at 184 bytes an entry,
 * retained up to two windows.
 *
 * The figure and the shape both follow `../debugReports/http.ts`, which caps
 * its own address-keyed map and prunes inline on every request. A full fleet
 * needs `MAX_PLAYERS` per lane, so this leaves room for several times the
 * honest working set.
 */
export const MAX_TRACKED_ADDRESSES = 1_024;

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
  /** Which bound refused: the caller's own budget, the lane backstop, or the tracking ceiling. */
  scope: 'address' | 'lane' | 'tracking';
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
    return { count: 0, windowStart: now, rejected: false };
  }

  function charge(store: Map<string, Bucket>, key: string, bucket: Bucket): void {
    bucket.count += 1;
    store.set(key, bucket);
  }

  /** Drops every bucket whose window has rolled. */
  function dropRolled(now: number): void {
    for (const [key, bucket] of buckets) {
      if (now - bucket.windowStart > CONNECTION_ADMISSION_WINDOW_MS) {
        buckets.delete(key);
      }
    }
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
        return { accepted: true, lane, firstRejection: false, count: 0, limit, scope: 'address' };
      }
      const laneLimit =
        lane === 'logs' ? LOG_CONNECTIONS_PER_WINDOW_ALL : GAMEPLAY_CONNECTIONS_PER_WINDOW_ALL;
      const key = `${lane}:${ip}`;
      const own = bucketFor(buckets, key, now);
      const all = bucketFor(laneTotals, lane, now);
      // Every budget is read before any of them is charged, so a refused
      // upgrade is never billed and never moves a window.
      if (own.count >= limit) {
        const firstRejection = !own.rejected;
        own.rejected = true;
        return { accepted: false, lane, firstRejection, count: own.count, limit, scope: 'address' };
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
          scope: 'lane',
        };
      }
      // A new key is what grows the map, so the ceiling is checked here and not
      // on a caller that already has a bucket. Rolled windows are dropped first,
      // so a window's worth of one-shot addresses cannot occupy the ceiling.
      if (!buckets.has(key)) {
        if (buckets.size >= MAX_TRACKED_ADDRESSES) {
          dropRolled(now);
        }
        if (buckets.size >= MAX_TRACKED_ADDRESSES) {
          return {
            accepted: false,
            lane,
            firstRejection: true,
            count: buckets.size,
            limit: MAX_TRACKED_ADDRESSES,
            scope: 'tracking',
          };
        }
      }
      charge(buckets, key, own);
      charge(laneTotals, lane, all);
      return {
        accepted: true,
        lane,
        firstRejection: false,
        count: own.count,
        limit,
        scope: 'address',
      };
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
      dropRolled(now);
      for (const [key, bucket] of laneTotals) {
        if (now - bucket.windowStart > CONNECTION_ADMISSION_WINDOW_MS) {
          laneTotals.delete(key);
        }
      }
    },
    /** Live bucket count, so `prune` has something to assert against. */
    size(): number {
      return buckets.size;
    },
  };
}
