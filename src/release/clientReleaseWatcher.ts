import { logger } from '../utils/Logger';

/** Only the same-origin Vercel client identity controls page refreshes. */
export const CLIENT_RELEASE_POLL_MS = 30_000;
const REQUEST_TIMEOUT_MS = 8000;
const RELOAD_GUARD_PREFIX = 'georoids:client-release-refresh';
const BUILD_RELEASE_PATTERN = /^[a-f0-9]{40}$/iu;

export interface ClientReleaseEnvironment {
  fetch: (input: string, init: RequestInit) => Promise<Response>;
  storage: Pick<Storage, 'getItem' | 'setItem'>;
  document: Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'>;
  reload: () => void;
}

/** The bundle and same-origin static manifest carry the same full Git SHA.
 * Confirm a change twice, then permit one reload per loaded bundle in this tab.
 * If propagation serves that old bundle again, its persisted guard prevents a
 * loop. A successfully loaded newer bundle gets its own future refresh attempt.
 */
export function watchClientRelease(
  buildRelease: unknown,
  environment: ClientReleaseEnvironment
): () => void {
  if (typeof buildRelease !== 'string' || !BUILD_RELEASE_PATTERN.test(buildRelease)) {
    return () => undefined;
  }
  const build = buildRelease.toLowerCase();
  let stopped = false;
  let failureReported = false;
  let pending: AbortController | undefined;
  let candidate: string | undefined;
  let requestTimeout: ReturnType<typeof setTimeout> | undefined;

  function stop(): void {
    if (stopped) {
      return;
    }
    stopped = true;
    clearInterval(interval);
    clearTimeout(requestTimeout);
    environment.document.removeEventListener('visibilitychange', onVisibility);
    pending?.abort();
  }

  async function poll(): Promise<void> {
    if (stopped || pending) {
      return;
    }
    const controller = new AbortController();
    pending = controller;
    requestTimeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await environment.fetch('/release.json', {
        method: 'GET',
        cache: 'no-store',
        redirect: 'error',
        credentials: 'same-origin',
        signal: controller.signal,
      });
      if (stopped) {
        return;
      }
      if (controller.signal.aborted) {
        candidate = undefined;
        return;
      }
      if (!response.ok || response.redirected) {
        throw new Error(
          `Invalid release response (${!response.ok ? `status=${response.status}` : 'redirected=true'})`
        );
      }
      const payload: unknown = await response.json();
      if (stopped || controller.signal.aborted) {
        candidate = undefined;
        return;
      }
      if (
        typeof payload !== 'object' ||
        payload === null ||
        Array.isArray(payload) ||
        !('releaseSha' in payload) ||
        typeof payload.releaseSha !== 'string' ||
        !BUILD_RELEASE_PATTERN.test(payload.releaseSha)
      ) {
        throw new Error('Invalid release manifest');
      }
      const published = payload.releaseSha.toLowerCase();
      failureReported = false;
      // The first same-build response is the normal baseline. A page already
      // stale on load may also refresh, after two matching full-SHA responses.
      if (published === build) {
        candidate = undefined;
        return;
      }
      if (candidate !== published) {
        candidate = published;
        return;
      }
      // Fail closed if tab storage is unavailable: a reload without a durable
      // guard could loop indefinitely on an old cached bundle/new manifest.
      const guardKey = `${RELOAD_GUARD_PREFIX}:${build}`;
      if (environment.storage.getItem(guardKey) !== null) {
        stop();
        return;
      }
      environment.storage.setItem(guardKey, published);
      stop();
      environment.reload();
    } catch (cause) {
      candidate = undefined;
      if (!stopped && !failureReported) {
        failureReported = true;
        logger.error(
          'CLIENT_RELEASE',
          'Release check failed; keeping the current client',
          cause instanceof Error ? cause : new Error(String(cause))
        );
      }
    } finally {
      clearTimeout(requestTimeout);
      if (pending === controller) {
        pending = undefined;
      }
    }
  }

  function onVisibility(): void {
    if (environment.document.visibilityState === 'visible') {
      void poll();
    }
  }

  const interval = setInterval(() => void poll(), CLIENT_RELEASE_POLL_MS);
  environment.document.addEventListener('visibilitychange', onVisibility);
  void poll();
  return stop;
}
