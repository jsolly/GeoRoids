/** Only the same-origin Vercel client identity controls page refreshes. */
export const CLIENT_RELEASE_POLL_MS = 30_000;
const REQUEST_TIMEOUT_MS = 8000;
const RELOAD_GUARD_KEY = 'georoids:client-release-refresh';

export interface ClientReleaseEnvironment {
  fetch: (input: string, init: RequestInit) => Promise<Response>;
  storage: Pick<Storage, 'getItem' | 'setItem'>;
  document: Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'>;
  reload: () => void;
}

/** Vite embeds an abbreviated Git SHA; deployment headers contain the full SHA.
 * Confirm a change twice, then permit one reload per loaded bundle in this tab.
 * If propagation serves that old bundle again, its persisted guard prevents a
 * loop. A successfully loaded newer bundle gets its own future refresh attempt.
 */
export function watchClientRelease(
  buildRelease: unknown,
  environment: ClientReleaseEnvironment
): () => void {
  if (typeof buildRelease !== 'string' || !/^[a-f0-9]{7,40}$/i.test(buildRelease)) {
    return () => undefined;
  }
  const build = buildRelease.toLowerCase();
  let stopped = false;
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
      const response = await environment.fetch('/', {
        method: 'HEAD',
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
      const published = response.headers.get('x-release-id')?.toLowerCase();
      if (!response.ok || response.redirected || !published || !/^[a-f0-9]{40}$/.test(published)) {
        candidate = undefined;
        return;
      }
      // The first same-build response is the normal baseline. A page already
      // stale on load may also refresh, after two matching full-SHA responses.
      if (published.startsWith(build)) {
        candidate = undefined;
        return;
      }
      if (candidate !== published) {
        candidate = published;
        return;
      }
      // Fail closed if tab storage is unavailable: a reload without a durable
      // guard could loop indefinitely on an old cached bundle/new edge header.
      const previous = environment.storage.getItem(RELOAD_GUARD_KEY);
      if (previous) {
        try {
          if ((JSON.parse(previous) as { build?: unknown }).build === build) {
            stop();
            return;
          }
        } catch {
          // An invalid old marker is replaced below before any reload.
        }
      }
      environment.storage.setItem(RELOAD_GUARD_KEY, JSON.stringify({ build, target: published }));
      stop();
      environment.reload();
    } catch {
      // Offline, unavailable metadata and blocked storage are best-effort misses.
      candidate = undefined;
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
