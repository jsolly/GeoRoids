import { expect, test } from 'vitest';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';
import { TestConfig } from '../../utils/test-config';

const { browserManager, screenshotManager } = createBrowserScenarioHooks();

test('a failed initial connection returns to Play and a retry joins the live arena', async () => {
  const page = browserManager.getCurrentPage();
  if (!page) {
    throw new Error('Game test page unavailable');
  }
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  let unavailable = true;
  await page.routeWebSocket(/\/ws(?:\?|$)/, (socket) => {
    if (unavailable) {
      socket.close({ code: 1013, reason: 'Temporary server outage' });
    } else {
      socket.connectToServer();
    }
  });
  await page.goto(TestConfig.GAME_URL);
  await page.locator('#start-game').click();
  await page.waitForFunction(() =>
    document
      .getElementById('network-status-banner')
      ?.textContent?.includes('Select Enter Game to try again')
  );
  expect(await page.locator('#start-game').isVisible()).toBe(true);
  expect(await page.locator('#start-game').isEnabled()).toBe(true);
  expect(await page.evaluate(() => window.gameController?.getIsGameRunning())).toBe(false);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: screenshotManager.getScreenshotPath(
      screenshotManager.getTimestampedFilename('failed-connection-retry-menu')
    ),
    fullPage: true,
  });
  unavailable = false;
  await page.locator('#playerNameInput').press('Enter');
  await new GameInteractions(page).waitForAsteroids(1);
  expect(await page.evaluate(() => window.gameController?.getIsGameRunning())).toBe(true);
  expect(await page.locator('#network-status-banner').isVisible()).toBe(false);
  expect(errors).toEqual([]);
});
