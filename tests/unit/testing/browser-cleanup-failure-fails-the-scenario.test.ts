/* @vitest-environment node */
import { beforeEach, expect, test, vi } from 'vitest';

const browserApi = await vi.hoisted(async () => {
  const { EventEmitter } = await import('node:events');
  const state = { connected: true };
  const page = Object.assign(new EventEmitter(), {
    close: vi.fn(),
    setViewportSize: vi.fn(),
    setExtraHTTPHeaders: vi.fn(),
    bringToFront: vi.fn(),
  });
  const context = { newPage: vi.fn(async () => page), close: vi.fn() };
  const browser = {
    newContext: vi.fn(async () => context),
    isConnected: () => state.connected,
    close: vi.fn(async () => {
      state.connected = false;
    }),
  };
  return { page, browser, state };
});

vi.mock('playwright', () => ({
  chromium: { launch: vi.fn(async () => browserApi.browser) },
}));

import { BrowserManager } from '../../integration/utils/browser-manager';

beforeEach(() => {
  vi.clearAllMocks();
  browserApi.state.connected = true;
});

test('a failed page close rejects scenario cleanup and keeps the page available for retry', async () => {
  const manager = new BrowserManager();
  await manager.initialize();
  await manager.createPage();
  const failure = new Error('page transport failed');
  browserApi.page.close.mockRejectedValueOnce(failure);

  await expect(manager.closeAllPages()).rejects.toMatchObject({ errors: [failure] });
  expect(manager.getCurrentPage()).toBe(browserApi.page);
  await manager.closeAllPages();
  expect(browserApi.page.close).toHaveBeenCalledTimes(2);
  expect(manager.getCurrentPage()).toBeNull();
  await manager.cleanup();
  expect(browserApi.browser.close).toHaveBeenCalledOnce();
});

test('failed final browser cleanup rejects and retains browser ownership until a successful retry', async () => {
  const manager = new BrowserManager();
  await manager.initialize();
  await manager.createPage({ hasTouch: true });
  const failure = new Error('browser transport failed');
  browserApi.browser.close.mockRejectedValueOnce(failure);

  await expect(manager.cleanup()).rejects.toMatchObject({ errors: [failure] });
  expect(browserApi.state.connected).toBe(true);
  expect(manager.getCurrentPage()).toBeNull();
  await manager.cleanup();
  expect(browserApi.browser.close).toHaveBeenCalledTimes(2);
  expect(manager.getCurrentPage()).toBeNull();
  await expect(manager.createPage()).rejects.toThrow('Browser not initialized');
});
