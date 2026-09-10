import { afterAll, afterEach, beforeAll, beforeEach } from 'vitest';
import { BrowserManager } from './browser-manager';
import { HealthChecker } from './health-checker';
import { ScreenshotManager } from './screenshot-manager';
import { TestServerControl } from './test-server-control';

/** Shared browser lifecycle hooks for scenario integration tests. */
export function createBrowserScenarioHooks(): {
  browserManager: BrowserManager;
  screenshotManager: ScreenshotManager;
} {
  const browserManager = new BrowserManager();
  const screenshotManager = new ScreenshotManager();

  beforeAll(async () => {
    await HealthChecker.checkAllServers();
    screenshotManager.ensureScreenshotsDirectory();
    await browserManager.initialize();
  });

  afterAll(async () => {
    await browserManager.cleanup();
  });

  beforeEach(async () => {
    await TestServerControl.resetWorld();
    await browserManager.createPage();
  });

  afterEach(async () => {
    await browserManager.closeAllPages();
    await TestServerControl.waitForWorldReset();
  });

  return { browserManager, screenshotManager };
}
