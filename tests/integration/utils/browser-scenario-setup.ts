import { afterAll, afterEach, beforeAll, beforeEach } from 'vitest';
import { BrowserManager } from './browser-manager';
import { checkAllServers } from './health-checker';
import { ScreenshotManager } from './screenshot-manager';
import { resetWorld, waitForWorldReset } from './test-server-control';

/** Shared browser lifecycle hooks for scenario integration tests. */
export function createBrowserScenarioHooks(testDir?: string): {
  browserManager: BrowserManager;
  screenshotManager: ScreenshotManager;
} {
  const browserManager = new BrowserManager();
  const screenshotManager = new ScreenshotManager(testDir);

  beforeAll(async () => {
    await checkAllServers();
    screenshotManager.ensureScreenshotsDirectory();
    await browserManager.initialize();
  });

  afterAll(async () => {
    await browserManager.cleanup();
  });

  beforeEach(async () => {
    await resetWorld();
    await browserManager.createPage();
  });

  afterEach(async () => {
    await browserManager.closeAllPages();
    await waitForWorldReset();
  });

  return { browserManager, screenshotManager };
}
