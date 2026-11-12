// GeoRoids-specific code-only production verification. Receipt fields retain
// the contract consumed by dotagents' production-smoke follower.
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import type WebSocket from 'ws';

type SmokeTimer = ReturnType<typeof setTimeout> | number;
interface SmokeClock {
  now(): number;
  sleep(ms: number, signal?: AbortSignal | undefined): Promise<unknown>;
  setTimeout(callback: () => void, ms: number): SmokeTimer;
  clearTimeout(timer: SmokeTimer | undefined): void;
}
interface VerifiedHttpResponse {
  url: string;
  status: number;
  headers: Headers;
  text(): Promise<string>;
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
}
export type SmokeSocketEvents = {
  open: [];
  message: [payload: WebSocket.RawData];
  close: [code: number, reason?: Buffer];
  error: [error: Error];
};
export interface SmokeSocket {
  readyState: number;
  send(text: string): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  on(event: 'open', listener: () => void): unknown;
  on(event: 'message', listener: (payload: WebSocket.RawData) => void): unknown;
  on(event: 'close', listener: (code: number, reason?: Buffer) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
}
type SocketFactory = (url: string, options: WebSocket.ClientOptions) => SmokeSocket;
type Observation = Record<string, unknown>;
interface SmokeContext {
  expectedSha: string | undefined;
  verifyHttp(url: string): VerifiedHttpResponse | Promise<VerifiedHttpResponse>;
  artifacts: string;
  observations: Observation[];
  clock: SmokeClock;
  signal: AbortSignal;
  createSocket: SocketFactory | undefined;
}
interface SmokeOptions {
  scenario: {
    productionUrl: string;
    smoke(context: SmokeContext): Promise<unknown>;
  };
  env?: NodeJS.ProcessEnv;
  fetcher?: (url: string, init: RequestInit) => Response | Promise<Response>;
  clock?: SmokeClock;
  createSocket?: SocketFactory;
  artifacts?: string;
  readinessMs?: number;
  pollMs?: number;
  behaviorMs?: number;
  report?: (error: Error) => unknown;
}
interface SmokeReceipt {
  requestId: string | undefined;
  releaseSha: string | undefined;
  observations: Observation[];
  errors: string[];
  success: boolean;
}

export class SmokeFailure extends Error {}
export function smokeCause(error: unknown): Error {
  return error instanceof Error ? error : new Error('Unexpected non-Error smoke failure');
}
export const smokeClock: SmokeClock = {
  now: () => performance.now(),
  sleep: (ms, signal) => delay(ms, undefined, { signal }),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (timer) => clearTimeout(timer),
};
export function requireEvidence(condition: unknown, message: string): asserts condition {
  const satisfied = Boolean(condition);
  if (!satisfied) {
    throw new SmokeFailure(message);
  }
}
export async function verifyProductionHttp({
  url,
  signal = new AbortController().signal,
  fetcher = fetch,
  clock = smokeClock,
  timeoutMs = 15000,
  observe = () => {},
}: {
  url: string;
  signal?: AbortSignal;
  fetcher?: (url: string, init: RequestInit) => Response | Promise<Response>;
  clock?: SmokeClock;
  timeoutMs?: number;
  observe?: (observation: Observation) => void;
}): Promise<VerifiedHttpResponse> {
  const request = new AbortController();
  let requestTimer: SmokeTimer | undefined;
  const expired = new Promise<never>((_, reject) => {
    requestTimer = clock.setTimeout(() => {
      reject(new SmokeFailure('Production HTTP request deadline exceeded'));
      request.abort();
    }, timeoutMs);
  });
  let response: Response;
  try {
    response = await Promise.race([
      fetcher(url, {
        redirect: 'follow',
        cache: 'no-store',
        signal: AbortSignal.any([signal, request.signal]),
      }),
      expired,
    ]);
    const requested = new URL(url),
      observed = new URL(response.url);
    requireEvidence(
      requested.protocol === 'https:' &&
        !requested.username &&
        !requested.password &&
        observed.origin === requested.origin &&
        observed.pathname === requested.pathname &&
        observed.search === requested.search &&
        !observed.username &&
        !observed.password &&
        Number.isInteger(response.status) &&
        response.status >= 200 &&
        response.status < 300,
      'Production HTTP response was unsuccessful or noncanonical'
    );
    observe({ url: requested.href, status: response.status });
    const readBody = async <T,>(
      read: () => Promise<T>,
      method: 'text' | 'json' | 'arrayBuffer'
    ): Promise<T> => {
      try {
        return await Promise.race([read(), expired]);
      } catch (error) {
        // biome-ignore lint/style/useErrorCause: JSON parser causes can expose response bodies; normalize before public reporting.
        throw new SmokeFailure('Production HTTP body failed or timed out', {
          // JSON parser messages can contain the response body. Keep only a
          // code-authored diagnostic at this external-data boundary.
          cause:
            method === 'json' && error instanceof SyntaxError
              ? new Error('Production HTTP JSON parsing failed')
              : smokeCause(error),
        });
      } finally {
        clock.clearTimeout(requestTimer);
      }
    };
    return {
      url: requested.href,
      status: response.status,
      headers: response.headers,
      text: () => readBody(() => response.text(), 'text'),
      json: () => readBody<unknown>(() => response.json(), 'json'),
      arrayBuffer: () => readBody(() => response.arrayBuffer(), 'arrayBuffer'),
    };
  } catch (error) {
    clock.clearTimeout(requestTimer);
    request.abort();
    throw error instanceof SmokeFailure
      ? error
      : new SmokeFailure('Production HTTP request failed', { cause: smokeCause(error) });
  }
}

export async function runNetworkSmoke({
  scenario,
  env = process.env,
  fetcher = fetch,
  clock = smokeClock,
  createSocket,
  artifacts = resolve('production-smoke-artifacts'),
  readinessMs = 120000,
  pollMs = 10000,
  behaviorMs = 240000,
  report = (error) => console.error(error),
}: SmokeOptions): Promise<SmokeReceipt> {
  await mkdir(artifacts, { recursive: true });
  const receipt: SmokeReceipt = {
    requestId: env['PRODUCTION_SMOKE_REQUEST_ID'],
    releaseSha: env['PRODUCTION_SMOKE_RELEASE_SHA'],
    observations: [],
    errors: [],
    success: false,
  };
  const controller = new AbortController();
  const signal = controller.signal;
  const reported = new Set<unknown>();
  const reportFailure = (error: unknown): void => {
    if (
      (error instanceof Error && error.name === 'AbortError' && signal.aborted) ||
      (error instanceof SmokeFailure && error.cause === undefined) ||
      reported.has(error)
    ) {
      return;
    }
    reported.add(error);
    report(smokeCause(error));
  };
  let timer: SmokeTimer | undefined;
  let behavior: Promise<unknown> | undefined;
  const verifyHttp = (url: string) =>
    verifyProductionHttp({
      url,
      signal,
      fetcher,
      clock,
      observe: (value) => receipt.observations.push(value),
    });
  try {
    requireEvidence(
      /^[a-zA-Z0-9_-]{1,100}$/u.test(receipt.requestId ?? ''),
      'Invalid smoke request ID'
    );
    requireEvidence(/^[0-9a-f]{40}$/u.test(receipt.releaseSha ?? ''), 'Invalid smoke release SHA');
    requireEvidence(
      new URL(scenario.productionUrl).protocol === 'https:',
      'Production URL must use HTTPS'
    );
    const deadline = clock.now() + readinessMs;
    for (;;) {
      try {
        const response = await verifyHttp(scenario.productionUrl);
        await response.arrayBuffer();
        break;
      } catch (error) {
        if (clock.now() >= deadline) {
          throw new SmokeFailure('Readiness deadline exceeded', { cause: error });
        }
        await clock.sleep(Math.min(pollMs, deadline - clock.now()), signal);
      }
    }
    behavior = scenario.smoke({
      expectedSha: receipt.releaseSha,
      verifyHttp,
      artifacts,
      observations: receipt.observations,
      clock,
      signal,
      createSocket,
    });
    await Promise.race([
      behavior,
      new Promise<never>((_, reject) => {
        timer = clock.setTimeout(() => {
          reject(new SmokeFailure('Behavior deadline exceeded'));
          controller.abort();
        }, behaviorMs);
      }),
    ]);
    receipt.success = true;
  } catch (error) {
    reportFailure(error);
    receipt.errors.push(
      error instanceof SmokeFailure ? error.message : 'Production verification failed'
    );
  } finally {
    clock.clearTimeout(timer);
    controller.abort();
    // The scenario owns its socket. Await its abort/close before retaining success
    // or returning a timed-out receipt, so work cannot continue after publication.
    if (behavior !== undefined) {
      await behavior.catch((error) => {
        reportFailure(error);
        if (error instanceof SmokeFailure && !receipt.errors.includes(error.message)) {
          receipt.errors.push(error.message);
        }
      });
    }
    if (receipt.errors.length > 0) {
      receipt.success = false;
    }
    await writeFile(resolve(artifacts, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`);
  }
  return receipt;
}
