/* @vitest-environment node */
import { beforeEach, expect, test, vi } from 'vitest';

const browserApi = vi.hoisted(() => {
  const page = {
    close: vi.fn(),
    setViewportSize: vi.fn(),
    setExtraHTTPHeaders: vi.fn(),
    bringToFront: vi.fn(),
  };
  const context = { newPage: vi.fn(async () => page) };
  const browser = { newContext: vi.fn(async () => context), close: vi.fn() };
  return { page, browser };
});

vi.mock('playwright', () => ({
  chromium: { launch: vi.fn(async () => browserApi.browser) },
}));

import { BrowserManager } from '../../integration/utils/browser-manager';

beforeEach(() => {
  vi.clearAllMocks();
});

test('a failed page close rejects scenario cleanup and keeps the page available for retry', async () => {
  const manager = new BrowserManager();
  await manager.initialize();
  await manager.createPage();
  const failure = new Error('page transport failed');
  browserApi.page.close.mockRejectedValueOnce(failure);

  await expect(manager.closeAllPages()).rejects.toBe(failure);
  expect(manager.getCurrentPage()).toBe(browserApi.page);
  await manager.closeAllPages();
  expect(browserApi.page.close).toHaveBeenCalledTimes(2);
  expect(manager.getCurrentPage()).toBeNull();
  await manager.cleanup();
  expect(browserApi.browser.close).toHaveBeenCalledOnce();
});

test('failed final browser cleanup rejects and retains ownership until a successful retry', async () => {
  const manager = new BrowserManager();
  await manager.initialize();
  await manager.createPage({ hasTouch: true });
  const failure = new Error('browser transport failed');
  browserApi.browser.close.mockRejectedValueOnce(failure);

  await expect(manager.cleanup()).rejects.toBe(failure);
  expect(manager.getCurrentPage()).toBe(browserApi.page);
  await manager.cleanup();
  expect(browserApi.browser.close).toHaveBeenCalledTimes(2);
  expect(manager.getCurrentPage()).toBeNull();
  await expect(manager.createPage()).rejects.toThrow('Browser not initialized');
});
