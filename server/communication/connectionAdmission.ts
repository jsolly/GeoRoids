export const GAMEPLAY_CONNECTIONS_PER_WINDOW = 50;
export const LOG_CONNECTIONS_PER_WINDOW = 6;
export const CONNECTION_ADMISSION_WINDOW_MS = 60_000;

export function connectionLimitsDisabled(env: {
  nodeEnv: string;
  processNodeEnv?: string;
  vitest?: string;
  enforceConnectionLimits?: boolean;
}): boolean {
  if (env.enforceConnectionLimits) {
    return false;
  }
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
