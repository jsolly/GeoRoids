// Generated from production-smoke-network.mts by generate-asset-boundaries.ts; do not edit.
// GeoRoids-specific code-only production verification. Receipt fields retain
// the contract consumed by dotagents' production-smoke follower.
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
export class SmokeFailure extends Error {}
export function smokeCause(error) {
  return error instanceof Error ? error : new Error('Unexpected non-Error smoke failure');
}
export const smokeClock = {
  now: () => performance.now(),
  sleep: (ms, signal) => delay(ms, undefined, { signal }),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (timer) => clearTimeout(timer),
};
export function requireEvidence(condition, message) {
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
}) {
  const request = new AbortController();
  let requestTimer;
  const expired = new Promise((_, reject) => {
    requestTimer = clock.setTimeout(() => {
      reject(new SmokeFailure('Production HTTP request deadline exceeded'));
      request.abort();
    }, timeoutMs);
  });
  let response;
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
    const readBody = async (read, method) => {
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
      json: () => readBody(() => response.json(), 'json'),
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
}) {
  await mkdir(artifacts, { recursive: true });
  const receipt = {
    requestId: env['PRODUCTION_SMOKE_REQUEST_ID'],
    releaseSha: env['PRODUCTION_SMOKE_RELEASE_SHA'],
    observations: [],
    errors: [],
    success: false,
  };
  const controller = new AbortController();
  const signal = controller.signal;
  const reported = new Set();
  const reportFailure = (error) => {
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
  let timer;
  let behavior;
  const verifyHttp = (url) =>
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
      new Promise((_, reject) => {
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
