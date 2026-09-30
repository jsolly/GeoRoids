import type { BrowserType } from 'playwright';
import { afterAll, afterEach, beforeAll, beforeEach } from 'vitest';
import { BrowserManager } from './browser-manager';
import { withFixtureEvidence } from './fixture-evidence';
import { checkAllServers } from './health-checker';
import { ScreenshotManager } from './screenshot-manager';
import { resetWorld } from './test-server-control';

/** Shared browser lifecycle hooks for scenario integration tests. */
export function createBrowserScenarioHooks(
  testDir?: string,
  browserType?: BrowserType
): {
  browserManager: BrowserManager;
  screenshotManager: ScreenshotManager;
} {
  const browserManager = new BrowserManager();
  const screenshotManager = new ScreenshotManager(testDir);

  beforeAll(async () => {
    await checkAllServers();
    screenshotManager.ensureScreenshotsDirectory();
    await browserManager.initialize(browserType);
  });

  afterAll(async () => {
    await browserManager.cleanup();
  });

  beforeEach(async () => {
    await resetWorld();
    await browserManager.createPage();
  });

  afterEach(async () => {
    let teardownAttempted = false;
    const teardown = async () => {
      teardownAttempted = true;
      const failures: unknown[] = [];
      try {
        await browserManager.closeAllPages();
      } catch (error) {
        failures.push(error);
      }
      try {
        await resetWorld();
      } catch (error) {
        failures.push(error);
      }
      if (failures.length > 0) {
        throw new AggregateError(failures, 'Scenario teardown failed');
      }
    };
    const page = browserManager.getCurrentPage();
    if (page) {
      const evidenceFailures: unknown[] = [];
      try {
        await withFixtureEvidence(page, 'scenario-teardown', async (stage) => {
          await stage('close-and-reset-request');
          await teardown();
          await stage('departed-and-reset');
        });
      } catch (error) {
        evidenceFailures.push(error);
        if (!teardownAttempted) {
          try {
            await teardown();
          } catch (cleanupError) {
            evidenceFailures.push(cleanupError);
          }
        }
      }
      if (evidenceFailures.length > 0) {
        throw new AggregateError(evidenceFailures, 'Scenario evidence or teardown failed');
      }
    } else {
      await teardown();
    }
  });

  return { browserManager, screenshotManager };
}
