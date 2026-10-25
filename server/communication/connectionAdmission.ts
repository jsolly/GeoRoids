import { clientNetwork, normalizeClientAddress } from './clientAddress';

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
/**
 * Upgrades a client retries on its own before giving up, so the most a network
 * spends per pilot at an honest rate. Mirrors `RECONNECT_DELAYS_MS.length` in
 * `src/network/services/connectionReconnect.ts`; server code cannot import
 * client code, so a test pins the two together.
 */
export const HONEST_LADDER_UPGRADES_PER_WINDOW = 5;
/**
 * The part of the lane ceiling only networks spending at or under the honest
 * ladder may draw on.
 *
 * Without it the ceiling is one undifferentiated counter: whoever spends it
 * first wins, so a few saturating callers refuse every later upgrade in the
 * window, including one from a network that has spent nothing. A client gives
 * up after its ladder — about fifteen seconds — and then shows a banner that
 * needs a manual reload, so a blackout outlasting the ladder is not a wait, it
 * is a lockout. Holding back the whole fleet's honest demand
 * (MAX_PLAYERS x HONEST_LADDER_UPGRADES_PER_WINDOW) prices saturating the lane
 * at one network per five upgrades instead of letting a dozen buy the lane.
 *
 * Callers past the ladder contend for what is left. Under a flood that squeezes
 * a genuinely heavy network — a large shared NAT reconnecting at once — and
 * that is the deliberate trade: when a lane is saturated someone is refused,
 * and refusing the callers already past an honest ladder keeps every pilot that
 * is not from getting in.
 */
export const GAMEPLAY_FLEET_RESERVE_PER_WINDOW = 500;
export const LOG_FLEET_RESERVE_PER_WINDOW = 50;

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

interface LaneBudgets {
  perClient: number;
  /** What networks already past the honest ladder may still draw from the lane. */
  beyondLadder: number;
  laneTotal: number;
}

const LANE_BUDGETS: Record<ConnectionLane, LaneBudgets> = {
  gameplay: {
    perClient: GAMEPLAY_CONNECTIONS_PER_WINDOW,
    beyondLadder: GAMEPLAY_CONNECTIONS_PER_WINDOW_ALL - GAMEPLAY_FLEET_RESERVE_PER_WINDOW,
    laneTotal: GAMEPLAY_CONNECTIONS_PER_WINDOW_ALL,
  },
  logs: {
    perClient: LOG_CONNECTIONS_PER_WINDOW,
    beyondLadder: LOG_CONNECTIONS_PER_WINDOW_ALL - LOG_FLEET_RESERVE_PER_WINDOW,
    laneTotal: LOG_CONNECTIONS_PER_WINDOW_ALL,
  },
};

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
  lastAttempt: number;
  rejected: boolean;
}

interface Refusal {
  firstRejection: boolean;
  count: number;
  limit: number;
  refusedBy: RefusalScope;
}

/**
 * Gameplay and log upgrades spend separate budgets, each bounded at three
 * widths: one client, the lane's share for networks past the honest retry
 * ladder, and the whole lane. A /logs flap must not close the next /ws join.
 *
 * Spend is tracked per network — an IPv4 /24 or an IPv6 /64 — as well as per
 * address, because a prefix is what a caller actually holds. A residential or
 * cloud IPv6 host is normally given a whole /64, so rotating the low bits costs
 * it nothing and used to buy a fresh budget every time, leaving the lane
 * ceiling as the only control over it.
 *
 * Buckets are created only when an upgrade is admitted, so the lane ceiling
 * bounds how many a window can add and a refused flood costs no memory.
 */
export function createConnectionAdmission(disabled: boolean) {
  const clients = new Map<string, Bucket>();
  const networks = new Map<string, Bucket>();
  const beyondLadder = new Map<string, Bucket>();
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

  /** The refusal this budget owes, or undefined while it still has room. */
  function refuse(
    bucket: Bucket | undefined,
    limit: number,
    refusedBy: RefusalScope
  ): Refusal | undefined {
    if (!bucket || bucket.count < limit) {
      return undefined;
    }
    const firstRejection = !bucket.rejected;
    bucket.rejected = true;
    return { firstRejection, count: bucket.count, limit, refusedBy };
  }

  return {
    admit(address: string, pathname: string, now: number): ConnectionAdmissionDecision {
      const lane: ConnectionLane = pathname === '/logs' ? 'logs' : 'gameplay';
      const budgets = LANE_BUDGETS[lane];
      // Normalized here rather than trusted from the caller: both keys below
      // depend on one spelling per host, and a limiter that reads whatever it is
      // handed is one upstream change away from the bypass it exists to close.
      const client = normalizeClientAddress(address) ?? address;
      const network = clientNetwork(client);
      if (disabled) {
        return {
          accepted: true,
          lane,
          firstRejection: false,
          count: 0,
          limit: budgets.perClient,
          network,
          refusedBy: null,
        };
      }
      const clientKey = `${lane}:${client}`;
      const networkKey = `${lane}:${network}`;
      const own = live(clients, clientKey, now);
      const net = live(networks, networkKey, now);
      const surge = live(beyondLadder, lane, now);
      const all = live(laneTotals, lane, now);
      // A network that has already climbed the honest ladder this window is one
      // of the callers saturating the lane, so from here it draws on the lane's
      // share for heavy spend instead of the reserve the fleet needs to rejoin.
      const pastLadder = (net?.count ?? 0) >= HONEST_LADDER_UPGRADES_PER_WINDOW;
      // Every budget is read before any is charged, so a caller is never billed
      // for an upgrade a wider budget went on to refuse.
      const refusal =
        refuse(own, budgets.perClient, 'client') ??
        (pastLadder ? refuse(surge, budgets.beyondLadder, 'reserve') : undefined) ??
        refuse(all, budgets.laneTotal, 'lane');
      if (refusal) {
        return { accepted: false, lane, network, ...refusal };
      }
      charge(clients, clientKey, own, now);
      charge(networks, networkKey, net, now);
      if (pastLadder) {
        charge(beyondLadder, lane, surge, now);
      }
      charge(laneTotals, lane, all, now);
      return {
        accepted: true,
        lane,
        firstRejection: false,
        count: own ? own.count : 1,
        limit: budgets.perClient,
        network,
        refusedBy: null,
      };
    },
    prune(now: number): void {
      for (const store of [clients, networks, beyondLadder, laneTotals]) {
        for (const [key, bucket] of store) {
          if (now - bucket.lastAttempt > CONNECTION_ADMISSION_WINDOW_MS) {
            store.delete(key);
          }
        }
      }
    },
  };
}
