import { Blob } from 'node:buffer';
import { createHash, webcrypto } from 'node:crypto';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ClientPerformanceMetrics } from '../../../src/diagnostics/performanceMetrics';
import { createPhoneCollector } from '../../../src/diagnostics/phoneCollector';

const collectors = new Set<ReturnType<typeof createPhoneCollector>>();
beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('Blob', Blob);
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance', 'Date'] });
});
afterEach(() => {
  for (const subject of collectors) {
    subject.dispose();
  }
  collectors.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
function collector(metrics = new ClientPerformanceMetrics(true), changed = vi.fn()) {
  const result = createPhoneCollector(metrics, changed);
  collectors.add(result);
  return result;
}

function storage() {
  const rows = new Map<string, unknown>();
  let writeError = false;
  const close = vi.fn();
  const database = {
    close,
    transaction: () => {
      const transaction = {
        error: new Error('Storage write failed'),
        oncomplete: () => {},
        onerror: () => {},
        onabort: () => {},
        objectStore: () => ({
          clear: () => rows.clear(),
          put: (value: unknown, key: string) => rows.set(key, value),
          get: (key: string) => {
            const request = { result: rows.get(key), onsuccess: () => {} };
            queueMicrotask(() => request.onsuccess());
            return request;
          },
        }),
      };
      queueMicrotask(() => (writeError ? transaction.onerror() : transaction.oncomplete()));
      return transaction;
    },
  };
  const open = vi.fn(() => {
    const request = { result: database, onsuccess: () => {} };
    queueMicrotask(() => request.onsuccess());
    return request;
  });
  vi.stubGlobal('indexedDB', { open });
  return {
    rows,
    close,
    open,
    failWrites: () => {
      writeError = true;
    },
  };
}

async function artifact(subject: ReturnType<typeof createPhoneCollector>) {
  const result = await subject.download();
  if (!result) {
    throw new Error('Missing download');
  }
  const envelope = JSON.parse(await result.blob.text());
  expect(envelope.checksumAlgorithm).toBe('SHA-256');
  expect(envelope.checksum).toBe(createHash('sha256').update(envelope.content).digest('hex'));
  return { result, content: JSON.parse(envelope.content) };
}

test('opening collection leaves benchmark samples undrained until Start and unavailable storage reports incomplete', async () => {
  const metrics = new ClientPerformanceMetrics(true);
  metrics.record('renderMs', 3);
  const subject = collector(metrics);
  expect(metrics.read().metrics['menu.renderMs']?.count).toBe(1);
  expect(subject.read().status).toBe('Performance: ready');
  vi.stubGlobal('indexedDB', {
    open: () => {
      throw new Error('Storage denied');
    },
  });
  await subject.start('Phone', 'Wi-Fi');
  expect(subject.read().status).toBe('Incomplete: Storage denied');
  expect(subject.read().canStart).toBe(true);
});

test('a stopped phone recording preserves metadata and checksummed samples through recovery', async () => {
  const saved = storage();
  const metrics = new ClientPerformanceMetrics(true);
  const subject = collector(metrics);
  await subject.start('Pixel 9', 'Wi-Fi, cooled');
  expect(subject.read().phase).toBe('recording');
  expect(() => metrics.read(true)).toThrow('Performance drain owned by phone collector');
  metrics.record('renderMs', 3);
  await vi.advanceTimersByTimeAsync(1000);
  subject.stop();
  expect(subject.read().canDownload).toBe(true);
  expect(() => metrics.read(true)).not.toThrow();
  const original = await artifact(subject);
  expect(original.content.schemaVersion).toBe(2);
  expect(original.content.metadata.device).toBe('Pixel 9');
  expect(original.content.metadata.conditions).toBe('Wi-Fi, cooled');
  expect(original.content.samples[0].metrics['menu.renderMs'].values).toEqual([3]);
  expect(original.content.samples).toHaveLength(2);
  subject.dispose();
  const restored = collector();
  await restored.recover();
  expect(restored.read().status).toBe('Performance: recovered');
  expect(restored.read().device).toBe('Pixel 9');
  expect((await artifact(restored)).content).toEqual(original.content);
  expect(saved.close).toHaveBeenCalled();
});

test('page hiding flushes a sample and page close stops with an explicit interruption reason', async () => {
  storage();
  const subject = collector();
  await subject.start('Phone', 'Wi-Fi');
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
  document.dispatchEvent(new Event('visibilitychange'));
  expect(subject.read().phase).toBe('recording');
  window.dispatchEvent(new Event('pagehide'));
  expect(subject.read().status).toContain('Page closed before explicit Stop');
  const saved = await artifact(subject);
  expect(saved.content.samples).toHaveLength(2);
  expect(vi.getTimerCount()).toBe(0);
});

test('recording stops at thirty minutes and oversized escaped samples stay within the artifact cap', async () => {
  storage();
  const metrics = new ClientPerformanceMetrics(true);
  const subject = collector(metrics);
  await subject.start('Phone', 'Controlled duration');
  // A delayed single drain exercises the same elapsed-time boundary without 1,800 intervals.
  vi.spyOn(performance, 'now').mockReturnValue(30 * 60 * 1000);
  await vi.advanceTimersByTimeAsync(1000);
  expect(subject.read().status).toContain('30 minute collection limit reached');
  expect(vi.getTimerCount()).toBe(0);
  vi.restoreAllMocks();
  await subject.start('Phone', 'Escaping capacity');
  metrics.setGraphicsSettings({ capacity: '\\'.repeat(9 * 1024 * 1024) });
  await vi.advanceTimersByTimeAsync(1000);
  expect(subject.read().status).toContain('32 MiB artifact limit reached');
  const bounded = await artifact(subject);
  expect(bounded.result.blob.size).toBeLessThanOrEqual(32 * 1024 * 1024);
  expect(bounded.content.samples).toHaveLength(0);
});

test('a failed save stops the drain and a later recovered corrupt sample is marked incomplete', async () => {
  const saved = storage();
  const metrics = new ClientPerformanceMetrics(true);
  const subject = collector(metrics);
  saved.failWrites();
  await subject.start('Phone', 'Storage failing');
  await vi.advanceTimersByTimeAsync(0);
  expect(subject.read().status).toContain('Storage write failed');
  expect(() => metrics.read(true)).not.toThrow();
  expect(vi.getTimerCount()).toBe(0);
  const good = storage();
  await subject.start('Phone', 'Recover corruption');
  subject.stop();
  await artifact(subject);
  const id = good.rows.get('latest');
  good.rows.set(`${id}:0`, '{broken');
  const restored = collector();
  await restored.recover();
  expect(restored.read().status).toContain('corrupt sample');
});

test('disposing during a pending storage open closes its late result without claiming or notifying', async () => {
  const close = vi.fn();
  const request = { result: { close }, onsuccess: () => {} };
  vi.stubGlobal('indexedDB', { open: () => request });
  const changed = vi.fn();
  const metrics = new ClientPerformanceMetrics(true);
  const subject = collector(metrics, changed);
  const starting = subject.start('Phone', 'Late open');
  subject.dispose();
  changed.mockClear();
  request.onsuccess();
  await starting;
  expect(close).toHaveBeenCalledExactlyOnceWith();
  expect(changed).not.toHaveBeenCalled();
  expect(() => metrics.read(true)).not.toThrow();
  expect(vi.getTimerCount()).toBe(0);
});

test.each(['resolve', 'reject'])(
  'a checksum that settles by %s after disposal cannot download or notify',
  async (settlement) => {
    storage();
    const changed = vi.fn();
    const subject = collector(new ClientPerformanceMetrics(true), changed);
    await subject.start('Phone', 'Late digest');
    subject.stop();
    const digest = Promise.withResolvers<ArrayBuffer>();
    vi.stubGlobal('crypto', {
      randomUUID: webcrypto.randomUUID.bind(webcrypto),
      subtle: { digest: vi.fn(() => digest.promise) },
    });
    const pending = subject.download();
    await vi.advanceTimersByTimeAsync(0);
    subject.dispose();
    changed.mockClear();
    if (settlement === 'resolve') {
      digest.resolve(new ArrayBuffer(32));
    } else {
      digest.reject(new Error('Late digest failure'));
    }
    expect(await pending).toBeNull();
    expect(changed).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  }
);

test('recovering a saved session never releases another active collector drain', async () => {
  storage();
  const metrics = new ClientPerformanceMetrics(true);
  const recording = collector(metrics);
  await recording.start('Phone', 'Active owner');
  await vi.advanceTimersByTimeAsync(0);
  const recovered = collector(metrics);
  await recovered.recover();
  expect(recovered.read().status).toContain('Recording interrupted');
  expect(() => metrics.read(true)).toThrow('Performance drain owned by phone collector');
  recovered.dispose();
  expect(() => metrics.read(true)).toThrow('Performance drain owned by phone collector');
  recording.stop();
  expect(() => metrics.read(true)).not.toThrow();
});

test('insecure collection keeps every recording command disabled', async () => {
  vi.stubGlobal('crypto', {});
  const subject = collector();
  expect(subject.read().phase).toBe('unavailable');
  expect(subject.read().status).toContain('requires HTTPS');
  await subject.start('Phone', 'No secure APIs');
  await subject.recover();
  expect(await subject.download()).toBeNull();
  expect(subject.read()).toMatchObject({
    canStart: false,
    canStop: false,
    canRecover: false,
    canDownload: false,
  });
  expect(vi.getTimerCount()).toBe(0);
});
