/* @vitest-environment node */
import { beforeEach, expect, test, vi } from 'vitest';

const browserApi = await vi.hoisted(async () => {
  const { EventEmitter } = await import('node:events');
  const state = { connected: true };
  const contexts: Array<{
    page: InstanceType<typeof EventEmitter> & {
      close: ReturnType<typeof vi.fn>;
      setViewportSize: ReturnType<typeof vi.fn>;
      setExtraHTTPHeaders: ReturnType<typeof vi.fn>;
      bringToFront: ReturnType<typeof vi.fn>;
    };
    newPage: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  }> = [];
  const makeContext = () => {
    const page = Object.assign(new EventEmitter(), {
      close: vi.fn(),
      setViewportSize: vi.fn(),
      setExtraHTTPHeaders: vi.fn(),
      bringToFront: vi.fn(),
    });
    const context = {
      page,
      newPage: vi.fn(async () => page),
      close: vi.fn(),
    };
    contexts.push(context);
    return context;
  };
  const browser = {
    newContext: vi.fn(async () => makeContext()),
    isConnected: () => state.connected,
    close: vi.fn(() => {
      state.connected = false;
    }),
  };
  return { browser, contexts, state };
});

vi.mock('playwright', () => ({
  chromium: { launch: vi.fn(async () => browserApi.browser) },
}));

import { BrowserManager } from '../../integration/utils/browser-manager';

beforeEach(() => {
  vi.clearAllMocks();
  browserApi.contexts.length = 0;
  browserApi.state.connected = true;
});

test('each pilot receives an isolated context while a reload can retain its pilot session', async () => {
  const manager = new BrowserManager();
  await manager.initialize();
  const firstPage = await manager.createPage();
  const secondPage = await manager.createPage({ hasTouch: true });

  expect(firstPage).not.toBe(secondPage);
  expect(browserApi.contexts).toHaveLength(2);
  expect(browserApi.contexts[0]).not.toBe(browserApi.contexts[1]);
  expect(browserApi.browser.newContext).toHaveBeenNthCalledWith(1, { hasTouch: false });
  expect(browserApi.browser.newContext).toHaveBeenNthCalledWith(2, {
    hasTouch: true,
    deviceScaleFactor: 2,
  });
  expect(browserApi.contexts[0]?.newPage).toHaveBeenCalledOnce();
  expect(browserApi.contexts[1]?.newPage).toHaveBeenCalledOnce();

  await manager.closeAllPages();
  expect(browserApi.contexts[0]?.close).toHaveBeenCalledOnce();
  expect(browserApi.contexts[1]?.close).toHaveBeenCalledOnce();
  await manager.cleanup();
});

test('a failed page close rejects scenario cleanup and keeps the page available for retry', async () => {
  const manager = new BrowserManager();
  await manager.initialize();
  await manager.createPage();
  const failure = new Error('page transport failed');
  const page = browserApi.contexts[0]?.page;
  if (!page) {
    throw new Error('test page was not created');
  }
  page.close.mockRejectedValueOnce(failure);

  await expect(manager.closeAllPages()).rejects.toMatchObject({ errors: [failure] });
  expect(manager.getCurrentPage()).toBe(page);
  await manager.closeAllPages();
  expect(page.close).toHaveBeenCalledTimes(2);
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
