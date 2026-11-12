import { setTimeout as delay } from 'node:timers/promises';
import { verifyProductionHttp } from './production-smoke-network.mjs';

const healthUrl = 'https://georoids-production-2403.up.railway.app/health';
const repository = 'jsolly/GeoRoids';
const marker = '<!-- georoids-production-health-watch:v1 -->';
const automation = 'github-actions[bot]';
type FailureReason = 'unavailable' | 'invalid-health' | 'persistence-failed';
type Probe = { kind: 'healthy' } | { kind: 'failed'; reason: FailureReason };
type Observation =
  | { kind: 'healthy'; attempts: number }
  | { kind: 'incident'; attempts: number; reason: FailureReason }
  | { kind: 'transient'; attempts: number };
type MonitorIssue = { number: number; state: 'open' | 'closed'; body: string };
type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function probe(fetcher: Fetcher, timeoutMs: number): Promise<Probe> {
  let value: unknown;
  try {
    value = await (await verifyProductionHttp({ url: healthUrl, fetcher, timeoutMs })).json();
  } catch {
    // Network/HTTP/parser errors can contain private response data. Publish only this category.
    return { kind: 'failed', reason: 'unavailable' };
  }
  const world = isRecord(value) ? value['world'] : undefined;
  const persistence = isRecord(world) ? world['persistence'] : undefined;
  if (
    !isRecord(value) ||
    (value['status'] !== 'healthy' && value['status'] !== 'unhealthy') ||
    !isRecord(persistence) ||
    persistence['mode'] !== 'worker' ||
    typeof persistence['failed'] !== 'boolean'
  ) {
    return { kind: 'failed', reason: 'invalid-health' };
  }
  return value['status'] === 'healthy' && persistence['failed'] === false
    ? { kind: 'healthy' }
    : { kind: 'failed', reason: 'persistence-failed' };
}

async function observe({
  healthFetcher,
  timeoutMs,
  sleep,
}: {
  healthFetcher: Fetcher;
  timeoutMs: number;
  sleep: () => Promise<unknown>;
}): Promise<Observation> {
  let healthy = 0;
  let failed = 0;
  let reason: FailureReason = 'unavailable';
  for (let attempts = 1; attempts <= 3; attempts++) {
    const sample = await probe(healthFetcher, timeoutMs);
    if (sample.kind === 'healthy') {
      healthy++;
      if (healthy === 2) {
        return { kind: 'healthy', attempts };
      }
    } else {
      failed++;
      reason = sample.reason;
      healthy = 0;
    }
    if (attempts < 3) {
      await sleep();
    }
  }
  return failed === 3
    ? { kind: 'incident', attempts: 3, reason }
    : { kind: 'transient', attempts: 3 };
}

function issueBody(observation: Exclude<Observation, { kind: 'transient' }>): string {
  const state = observation.kind === 'healthy' ? 'recovered' : observation.reason;
  return `${marker}\n@jsolly Production health: ${state}.\n\nRead-only monitor of ${healthUrl}. ${observation.attempts} bounded probes; no health payload is retained.\n\nThis issue is reused for subsequent incidents and closed after two consecutive healthy probes. GitHub notification preferences control delivery.\n\n\\- John Solly's AI Assistant\n<!-- agent: github-actions -->\n`;
}

/** The scheduled workflow serializes all callers; POST is never retried blindly. */
export async function runProductionHealthWatch({
  token,
  healthFetcher = fetch,
  apiFetcher = fetch,
  timeoutMs = 15000,
  sleep = () => delay(10000),
}: {
  token: string;
  healthFetcher?: Fetcher;
  apiFetcher?: Fetcher;
  timeoutMs?: number;
  sleep?: () => Promise<unknown>;
}): Promise<{ observation: Observation; action: 'none' | 'created' | 'updated' }> {
  if (!token) {
    throw new Error('Production health watch requires GITHUB_TOKEN');
  }
  const observation = await observe({ healthFetcher, timeoutMs, sleep });
  if (observation.kind === 'transient') {
    return { observation, action: 'none' };
  }

  async function request(path: string, method = 'GET', payload?: unknown): Promise<unknown> {
    try {
      const pending: Promise<Response> = apiFetcher(
        `https://api.github.com/repos/${repository}${path}`,
        {
          method,
          redirect: 'error',
          signal: AbortSignal.timeout(timeoutMs),
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'Content-Type': 'application/json',
            'X-GitHub-Api-Version': '2022-11-28',
          },
          ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
        }
      );
      const response = await pending;
      if (!response.ok) {
        throw new Error('GitHub API rejected health watch operation');
      }
      return await response.json();
    } catch (error) {
      // Never forward HTTP response bodies, tokens or fetch error URLs into workflow logs.
      throw new Error(
        'GitHub health watch operation failed; inspect repository permissions/API status',
        { cause: error }
      );
    }
  }

  const owned: MonitorIssue[] = [];
  for (let page = 1; ; page++) {
    const entries = await request(
      `/issues?state=all&creator=${encodeURIComponent(automation)}&per_page=100&page=${page}`
    );
    if (!Array.isArray(entries)) {
      throw new Error('Malformed GitHub issue listing');
    }
    for (const entry of entries) {
      if (!isRecord(entry)) {
        throw new Error('Malformed GitHub issue');
      }
      const author = entry['user'];
      if (
        'pull_request' in entry ||
        !isRecord(author) ||
        author['login'] !== automation ||
        author['type'] !== 'Bot' ||
        typeof entry['body'] !== 'string' ||
        !entry['body'].startsWith(`${marker}\n`)
      ) {
        continue;
      }
      const number = entry['number'];
      const state = entry['state'];
      if (
        typeof number !== 'number' ||
        !Number.isSafeInteger(number) ||
        number <= 0 ||
        (state !== 'open' && state !== 'closed')
      ) {
        throw new Error('Malformed monitor issue');
      }
      owned.push({ number, state, body: entry['body'] });
    }
    if (entries.length < 100) {
      break;
    }
    if (page === 100) {
      throw new Error('Health watch issue listing exceeded pagination limit');
    }
  }
  if (owned.length > 1) {
    throw new Error('Multiple monitor-owned issues require operator reconciliation');
  }
  const existing = owned[0];
  if (!existing) {
    if (observation.kind === 'healthy') {
      return { observation, action: 'none' };
    }
    await request('/issues', 'POST', {
      title: 'Production server health incident',
      body: issueBody(observation),
    });
    return { observation, action: 'created' };
  }
  const state = observation.kind === 'healthy' ? 'closed' : 'open';
  const body = issueBody(observation);
  // Attempts can vary on recovery; closed healthy issues and unchanged incidents stay quiet.
  if (existing.state === state && (state === 'closed' || existing.body === body)) {
    return { observation, action: 'none' };
  }
  await request(`/issues/${existing.number}`, 'PATCH', { state, body });
  return { observation, action: 'updated' };
}
