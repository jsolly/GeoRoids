export const CONNECTION_ADMISSION_WINDOW_MS = 60_000;
/** Joins beyond this many live pilots are refused before an actor exists. */
export const MAX_PLAYERS = 100;

/**
 * One drop episode's gameplay demand from one pilot: the upgrade it makes when
 * its socket drops, plus every rung of the client's retry ladder.
 *
 * This is NOT a per-window worst case. The client resets its ladder on every
 * successful open and the floor between rungs is 500 ms, so a link that flaps
 * can spend more than this in a window. It is the demand a deploy or a stall
 * produces, which is the burst these budgets exist to carry.
 *
 * `server/` may not import `src/`, so the step count is restated here and
 * pinned against the real `RECONNECT_DELAYS_MS` by a test that imports both.
 */
const RECONNECT_LADDER_STEPS = 5;
export const UPGRADES_PER_DROP_EPISODE = 1 + RECONNECT_LADDER_STEPS;

/**
 * One pilot's diagnostics demand when a deploy reopens the fleet's sockets: the
 * record it forwards, plus two retries inside the window.
 *
 * This is deliberately BELOW the ceiling the client's own floor permits. A page
 * waits five seconds between log-socket attempts, so a pilot whose sockets keep
 * closing -- each one passing its message quota -- can attempt twelve times in a
 * window and will be refused for the rest of it. The sink is the reason: every
 * admitted socket brings a fresh 256 KiB ingress quota and `client.log` retains
 * one 10 MiB segment plus one rotation, so sizing this lane at the client's
 * twelve would license 300 MiB a window into 20 MiB of retained evidence.
 * Sizing that rotation and accounting forwarded bytes per address are the fixes
 * for that; neither belongs in an admission limiter.
 */
const LOG_SOCKETS_PER_PILOT_ON_DEPLOY = 3;

/**
 * These budgets are spent by the WHOLE FLEET, not by one pilot, so they are
 * sized for a full fleet.
 *
 * Behind Railway's public HTTP ingress `req.socket.remoteAddress` is the edge
 * proxy, so every pilot is charged to one bucket. With a gameplay budget of 50
 * against `MAX_PLAYERS` of 100 the limit sat BELOW capacity: a deploy or a stall
 * re-upgrades the whole fleet at once, and the 51st reconnect in the window was
 * refused with 429, so a full server could not come back after a deploy. The
 * diagnostics lane was worse -- 6 sockets for the entire server, when a deploy
 * makes every pilot forward a record.
 *
 * Read these as a budget per busy period, not as a rate per minute. `admit()`
 * resets a bucket only after a full window with no ACCEPTED upgrade in that
 * lane, and a refusal does not advance that clock, so accepted upgrades
 * accumulate without decay for as long as the lane stays busy. A deploy is
 * carried because a restarted process starts with an empty bucket map, not
 * because the budget refills on a schedule. A lane that stays continuously busy
 * still reaches its budget eventually and then refuses until it goes quiet for
 * a window -- twelve times further away for gameplay and fifty times for logs
 * than on the previous values, but not removed. Making the window a true fixed
 * window is a separate change: it trades that lockout for a sustained caller
 * holding the whole budget indefinitely.
 *
 * Charging each pilot's own forwarded address instead was tried and abandoned
 * (see jsolly/GeoRoids#873): per-client fairness needs a caller-supplied
 * header as the bucket key, which makes the bucket map attacker-diverse, and
 * every bound added to contain that either refused honest callers or became a
 * shared resource one host could exhaust. Four revisions, six Critical findings.
 * Scaling the shared budget keeps the one bucket, so there is no new key, no new
 * map and no new bound -- the limit simply stops sitting below the capacity the
 * server advertises.
 *
 * What this does not buy: per-client fairness. One abusive caller can still
 * spend the fleet's budget, exactly as on the previous limit, only now the
 * threshold is higher.
 *
 * It also costs something, and the honest statement is not that the raise is
 * free. The quotas behind this budget are per SOCKET, not per address: each
 * admitted socket brings a fresh message and byte allowance, `MAX_PLAYERS` is
 * enforced on the join message rather than on the upgrade, and nothing here
 * closes a socket that never joins. So the rate at which one unauthenticated
 * address can accumulate sockets, and the bytes it can push through them, rise
 * with these numbers -- twelve times for gameplay, fifty for logs. What is
 * missing is a bound on CONCURRENT sockets and a deadline for an unjoined one;
 * the old budget did not provide either, it only slowed the accumulation. Both
 * belong in their own change, and the log sink needs a rotation sized for what
 * it can now receive.
 */
export const GAMEPLAY_CONNECTIONS_PER_WINDOW = MAX_PLAYERS * UPGRADES_PER_DROP_EPISODE;
export const LOG_CONNECTIONS_PER_WINDOW = MAX_PLAYERS * LOG_SOCKETS_PER_PILOT_ON_DEPLOY;

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
  lastAttempt: number;
  rejected: boolean;
}

/**
 * Gameplay and log upgrades spend separate per-address budgets.
 * A /logs flap must not close the next /ws join.
 */
export function createConnectionAdmission(disabled: boolean) {
  const buckets = new Map<string, Bucket>();

  return {
    admit(ip: string, pathname: string, now: number): ConnectionAdmissionDecision {
      const lane: ConnectionLane = pathname === '/logs' ? 'logs' : 'gameplay';
      const limit = lane === 'logs' ? LOG_CONNECTIONS_PER_WINDOW : GAMEPLAY_CONNECTIONS_PER_WINDOW;
      if (disabled) {
        return { accepted: true, lane, firstRejection: false, count: 0, limit };
      }
      const key = `${lane}:${ip}`;
      const existing = buckets.get(key);
      if (!existing || now - existing.lastAttempt > CONNECTION_ADMISSION_WINDOW_MS) {
        buckets.set(key, { count: 1, lastAttempt: now, rejected: false });
        return { accepted: true, lane, firstRejection: false, count: 1, limit };
      }
      if (existing.count >= limit) {
        const firstRejection = !existing.rejected;
        existing.rejected = true;
        return {
          accepted: false,
          lane,
          firstRejection,
          count: existing.count,
          limit,
        };
      }
      existing.count += 1;
      existing.lastAttempt = now;
      return { accepted: true, lane, firstRejection: false, count: existing.count, limit };
    },
    prune(now: number): void {
      for (const [key, bucket] of buckets) {
        if (now - bucket.lastAttempt > CONNECTION_ADMISSION_WINDOW_MS) {
          buckets.delete(key);
        }
      }
    },
  };
}
