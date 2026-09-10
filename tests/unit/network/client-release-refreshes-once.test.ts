import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  CLIENT_RELEASE_POLL_MS,
  type ClientReleaseEnvironment,
  watchClientRelease,
} from '../../../src/release/clientReleaseWatcher';
import { logger } from '../../../src/utils/Logger';

vi.mock('../../../src/utils/Logger', () => ({ logger: { error: vi.fn() } }));

const CURRENT = 'a9755405dcfd546ace3e92b4dc8c3ff53d9bb598';
const NEXT = 'b'.repeat(40);
const LATER = 'c'.repeat(40);
const stops: Array<() => void> = [];

function response(release?: string, status = 200): Response {
  return new Response(null, { status, headers: release ? { 'x-release-id': release } : {} });
}

function fixture() {
  const target = new EventTarget();
  const values = new Map<string, string>();
  const fetch = vi.fn<ClientReleaseEnvironment['fetch']>().mockResolvedValue(response(CURRENT));
  const reload = vi.fn();
  const environment: ClientReleaseEnvironment = {
    fetch,
    reload,
    storage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => {
        values.set(key, value);
      },
    },
    document: {
      visibilityState: 'visible',
      addEventListener: target.addEventListener.bind(target),
      removeEventListener: target.removeEventListener.bind(target),
    },
  };
  return { fetch, reload, environment, target, values };
}

async function start(f: ReturnType<typeof fixture>, build = CURRENT.slice(0, 7)) {
  const stop = watchClientRelease(build, f.environment);
  stops.push(stop);
  await vi.advanceTimersByTimeAsync(0);
  return stop;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
});
afterEach(() => {
  for (const stop of stops.splice(0)) {
    stop();
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('open clients refresh only for a verified published client release', () => {
  test('a current baseline then two matching changed headers refreshes exactly once across later polls', async () => {
    const f = fixture();
    await start(f);
    expect(f.reload).not.toHaveBeenCalled();
    expect(f.fetch).toHaveBeenCalledWith(
      '/',
      expect.objectContaining({
        method: 'HEAD',
        cache: 'no-store',
        redirect: 'error',
        credentials: 'same-origin',
      })
    );
    f.fetch.mockResolvedValue(response(NEXT));
    await vi.advanceTimersByTimeAsync(CLIENT_RELEASE_POLL_MS);
    expect(f.reload).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(CLIENT_RELEASE_POLL_MS);
    expect(f.reload).toHaveBeenCalledTimes(1);
    const polls = f.fetch.mock.calls.length;
    await vi.advanceTimersByTimeAsync(CLIENT_RELEASE_POLL_MS * 4);
    f.target.dispatchEvent(new Event('visibilitychange'));
    expect(f.fetch).toHaveBeenCalledTimes(polls);
    expect(f.reload).toHaveBeenCalledTimes(1);
  });

  test('full published SHAs matching the abbreviated build remain current', async () => {
    const f = fixture();
    await start(f, CURRENT.slice(0, 9).toUpperCase());
    await vi.advanceTimersByTimeAsync(CLIENT_RELEASE_POLL_MS * 3);
    expect(f.reload).not.toHaveBeenCalled();
    expect(f.values.size).toBe(0);
  });

  test('missing, unknown, abbreviated, failed and offline responses never confirm a change', async () => {
    const f = fixture();
    await start(f);
    const redirected = response(NEXT);
    Object.defineProperty(redirected, 'redirected', { value: true });
    for (const invalid of [
      redirected,
      response(),
      response('unknown'),
      response('dev'),
      response(NEXT.slice(0, 7)),
      response(NEXT, 503),
    ]) {
      f.fetch.mockResolvedValue(response(NEXT));
      await vi.advanceTimersByTimeAsync(CLIENT_RELEASE_POLL_MS);
      f.fetch.mockResolvedValue(invalid);
      await vi.advanceTimersByTimeAsync(CLIENT_RELEASE_POLL_MS);
    }
    f.fetch.mockResolvedValue(response(NEXT));
    await vi.advanceTimersByTimeAsync(CLIENT_RELEASE_POLL_MS);
    f.fetch.mockRejectedValue(new Error('offline'));
    await vi.advanceTimersByTimeAsync(CLIENT_RELEASE_POLL_MS);
    f.fetch.mockResolvedValue(response(NEXT));
    await vi.advanceTimersByTimeAsync(CLIENT_RELEASE_POLL_MS);
    expect(f.reload).not.toHaveBeenCalled();
    expect(f.values.size).toBe(0);
  });

  test('a stale initial bundle refreshes once, then cached copies cannot loop while the newer bundle can follow its next release', async () => {
    const f = fixture();
    f.fetch.mockResolvedValue(response(NEXT));
    await start(f);
    await vi.advanceTimersByTimeAsync(CLIENT_RELEASE_POLL_MS);
    expect(f.reload).toHaveBeenCalledTimes(1);
    await start(f); // The edge served the old bundle again after its reload.
    await vi.advanceTimersByTimeAsync(CLIENT_RELEASE_POLL_MS * 3);
    expect(f.reload).toHaveBeenCalledTimes(1);
    await start(f, NEXT.slice(0, 7));
    f.fetch.mockResolvedValue(response(LATER));
    await vi.advanceTimersByTimeAsync(CLIENT_RELEASE_POLL_MS * 2);
    expect(f.reload).toHaveBeenCalledTimes(2);
  });

  test('visible resume polls promptly, overlapping requests coalesce, and cleanup aborts and detaches the watcher', async () => {
    const f = fixture();
    const stop = await start(f);
    Object.defineProperty(f.environment.document, 'visibilityState', {
      value: 'hidden',
      configurable: true,
    });
    f.target.dispatchEvent(new Event('visibilitychange'));
    expect(f.fetch).toHaveBeenCalledTimes(1);
    Object.defineProperty(f.environment.document, 'visibilityState', {
      value: 'visible',
      configurable: true,
    });
    let resolve!: (value: Response) => void;
    f.fetch.mockImplementation(
      () =>
        new Promise<Response>((done) => {
          resolve = done;
        })
    );
    f.target.dispatchEvent(new Event('visibilitychange'));
    f.target.dispatchEvent(new Event('visibilitychange'));
    expect(f.fetch).toHaveBeenCalledTimes(2);
    const request = f.fetch.mock.calls[1]?.[1];
    stop();
    expect(request?.signal?.aborted).toBe(true);
    resolve(response(NEXT));
    await vi.advanceTimersByTimeAsync(CLIENT_RELEASE_POLL_MS * 2);
    f.target.dispatchEvent(new Event('visibilitychange'));
    expect(f.fetch).toHaveBeenCalledTimes(2);
    expect(f.reload).not.toHaveBeenCalled();
  });

  test('unknown builds and blocked tab storage cannot trigger an unsafe reload loop', async () => {
    const f = fixture();
    await start(f, 'unknown');
    expect(f.fetch).not.toHaveBeenCalled();
    f.fetch.mockResolvedValue(response(NEXT));
    f.environment.storage.setItem = () => {
      throw new Error('storage blocked');
    };
    await start(f);
    await vi.advanceTimersByTimeAsync(CLIENT_RELEASE_POLL_MS * 4);
    expect(f.reload).not.toHaveBeenCalled();
  });
});

test('an offline release check keeps the loaded client and logs one error during the outage', async () => {
  const f = fixture();
  const cause = new Error('offline');
  const log = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
  f.fetch.mockRejectedValue(cause);
  await start(f);
  await vi.advanceTimersByTimeAsync(CLIENT_RELEASE_POLL_MS * 3);
  expect(f.reload).not.toHaveBeenCalled();
  expect(log).toHaveBeenCalledExactlyOnceWith(
    'CLIENT_RELEASE',
    'Release check failed; keeping the current client',
    cause
  );
});

test('an invalid release response logs once until a valid response restores the check', async () => {
  const f = fixture();
  await start(f);
  f.fetch.mockResolvedValue(response(NEXT, 503));
  await vi.advanceTimersByTimeAsync(CLIENT_RELEASE_POLL_MS);
  await vi.advanceTimersByTimeAsync(CLIENT_RELEASE_POLL_MS);
  expect(logger.error).toHaveBeenCalledExactlyOnceWith(
    'CLIENT_RELEASE',
    'Release check failed; keeping the current client',
    expect.objectContaining({ message: 'Invalid release response (status=503)' })
  );

  f.fetch.mockResolvedValue(response(CURRENT));
  await vi.advanceTimersByTimeAsync(CLIENT_RELEASE_POLL_MS);
  f.fetch.mockResolvedValue(response(NEXT, 503));
  await vi.advanceTimersByTimeAsync(CLIENT_RELEASE_POLL_MS);
  expect(logger.error).toHaveBeenCalledTimes(2);
});
