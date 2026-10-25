import { clientNetwork, normalizeClientAddress } from './clientNetwork';

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
 * The half of a lane ceiling only callers spending at or under the honest rate
 * may draw on.
 *
 * Without it the ceiling is one undifferentiated counter: whoever spends it
 * first wins, so a few saturating callers refuse every later upgrade in the
 * window, including one from a network that has spent nothing. A client gives
 * up after its ladder and then shows a banner that needs a manual reload, so a
 * blackout outlasting the ladder is a lockout rather than a wait.
 *
 * Each ceiling is twice its lane's worst honest demand, so half of it is that
 * demand exactly. Reserving half therefore leaves a half that is also
 * fleet-sized: honest traffic can always spend its worst case whatever a flood
 * is doing, and a fleet sharing one NAT still rejoins once past the ladder,
 * because the remaining share alone covers it. A test pins both halves against
 * that demand rather than against this arithmetic.
 */
export const GAMEPLAY_FLEET_RESERVE = GAMEPLAY_CONNECTIONS_PER_WINDOW_ALL / 2;
export const LOG_FLEET_RESERVE = LOG_CONNECTIONS_PER_WINDOW_ALL / 2;

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

/**
 * Which budget refused an upgrade: the caller's own address, the share of the
 * lane left to networks past the honest ladder, or the whole lane.
 */
type RefusalScope = 'client' | 'reserve' | 'lane';

interface ConnectionAdmissionDecision {
  accepted: boolean;
  lane: ConnectionLane;
  /** First rejection in this window. Later rejects stay quiet so a flap cannot warn per socket. */
  firstRejection: boolean;
  count: number;
  limit: number;
  /** The network charged for this upgrade, for the refusal log. */
  network: string;
  /** The budget that refused this upgrade, or null when it was admitted. */
  refusedBy: RefusalScope | null;
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
 * Gameplay and log upgrades spend separate budgets, each bounded at three
 * widths: one client, the lane's share for networks past the honest retry
 * ladder, and the whole lane. A /logs flap must not close the next /ws join.
 *
 * Spend is charged to a network — an IPv4 /24 or an IPv6 /64 — as well as to an
 * address, because a prefix is what a caller actually holds. A residential or
 * cloud IPv6 host is normally given a whole /64, so rotating the low bits cost
 * nothing and bought a fresh budget every time, leaving the lane ceiling as the
 * only control over it; see `clientNetwork`.
 */
export function createConnectionAdmission(disabled: boolean) {
  const buckets = new Map<string, Bucket>();
  const networks = new Map<string, Bucket>();
  const beyondLadder = new Map<string, Bucket>();
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
      const reserve = lane === 'logs' ? LOG_FLEET_RESERVE : GAMEPLAY_FLEET_RESERVE;
      const unattributed = ip === UNATTRIBUTED_CLIENT;
      // Unattributable callers answer to the lane ceiling alone; see UNATTRIBUTED_CLIENT.
      const limit = unattributed
        ? laneLimit
        : lane === 'logs'
          ? LOG_CONNECTIONS_PER_WINDOW
          : GAMEPLAY_CONNECTIONS_PER_WINDOW;
      // Normalized here rather than trusted from the caller: both keys below
      // depend on one spelling per host, and a limiter that reads whatever it
      // is handed is one upstream change away from the bypass it closes.
      const client = unattributed ? ip : (normalizeClientAddress(ip) ?? ip);
      const network = unattributed ? ip : clientNetwork(client);
      if (disabled) {
        return {
          accepted: true,
          lane,
          firstRejection: false,
          count: 0,
          limit,
          network,
          refusedBy: null,
        };
      }
      const key = `${lane}:${client}`;
      const networkKey = `${lane}:${network}`;
      const own = bucketFor(buckets, key, now);
      const net = bucketFor(networks, networkKey, now);
      const surge = bucketFor(beyondLadder, lane, now);
      const all = bucketFor(laneTotals, lane, now);
      // A network already past the honest ladder this window is one of the
      // callers saturating the lane, so from here it draws on the lane's share
      // for heavy spend rather than the reserve the fleet needs to rejoin.
      // Unattributable traffic is exempt: it is not a caller's choice, and by
      // design it answers to the lane ceiling alone.
      const pastLadder = !unattributed && net.count >= WORST_HONEST_UPGRADES_PER_PILOT;
      // Every budget is read before any is charged, so a refused upgrade is
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
          network,
          refusedBy: 'client',
        };
      }
      if (pastLadder && surge.count >= laneLimit - reserve) {
        const firstRejection = !surge.rejected;
        surge.rejected = true;
        return {
          accepted: false,
          lane,
          firstRejection,
          count: surge.count,
          limit: laneLimit - reserve,
          network,
          refusedBy: 'reserve',
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
          network,
          refusedBy: 'lane',
        };
      }
      charge(buckets, key, own, now);
      charge(networks, networkKey, net, now);
      if (pastLadder) {
        charge(beyondLadder, lane, surge, now);
      }
      charge(laneTotals, lane, all, now);
      return {
        accepted: true,
        lane,
        firstRejection: false,
        count: own.count,
        limit,
        network,
        refusedBy: null,
      };
    },
    prune(now: number): void {
      for (const store of [buckets, networks, beyondLadder, laneTotals]) {
        for (const [key, bucket] of store) {
          if (now - bucket.lastAttempt > CONNECTION_ADMISSION_WINDOW_MS) {
            store.delete(key);
          }
        }
      }
    },
  };
}
