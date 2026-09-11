import { afterEach, expect, test, vi } from 'vitest';
import { ClientPerformanceMetrics } from '../../../src/diagnostics/performanceMetrics';
import { installPhoneCollector } from '../../../src/diagnostics/phoneCollector';

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

test('opening collection controls leaves benchmark samples undrained until Start', () => {
  const metrics = new ClientPerformanceMetrics(true);
  metrics.record('renderMs', 3);
  installPhoneCollector(metrics);
  expect(metrics.read().metrics['menu.renderMs']?.count).toBe(1);
  expect(document.querySelector('aside')?.textContent).toContain('Performance: ready');
});

test('unavailable phone storage visibly marks collection incomplete', async () => {
  vi.stubGlobal('indexedDB', {
    open: () => {
      throw new Error('Storage denied');
    },
  });
  installPhoneCollector(new ClientPerformanceMetrics(true));
  document.querySelector('button')?.click();
  await vi.waitFor(() =>
    expect(document.querySelector('aside')?.textContent).toContain('Incomplete: Storage denied')
  );
});
