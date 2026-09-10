import { expect, test } from 'vitest';
import {
  assertNoBrowserDiagnostics,
  watchBrowserDiagnostics,
} from '../../utils/browser-diagnostics';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';
import { TestConfig } from '../../utils/test-config';

const { browserManager, screenshotManager } = createBrowserScenarioHooks(__dirname);

for (const { viewport, failure } of [
  { name: 'desktop', width: 1280, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
].flatMap((viewport) =>
  (['rejected', 'unsupported'] as const).map((failure) => ({ viewport, failure }))
)) {
  test(
    `${failure === 'unsupported' ? 'An' : 'A'} ${failure} join returns to the menu and a pilot can retry on ${viewport.name}`,
    async () => {
      const page = browserManager.getCurrentPage();
      if (!page) {
        throw new Error('Page not available');
      }
      await page.setViewportSize(viewport);
      let rejected = false;
      await page.routeWebSocket(
        (url) => url.pathname === '/ws',
        (socket) => {
          if (rejected) {
            socket.connectToServer();
            return;
          }
          socket.onMessage((raw) => {
            const message = JSON.parse(String(raw));
            if (message.type === 'join') {
              rejected = true;
              socket.send(
                JSON.stringify(
                  failure === 'rejected'
                    ? { type: 'error', data: 'Scenario rejected join' }
                    : {
                        type: 'joined',
                        data: {
                          id: message.id,
                          name: 'Old server',
                          position: { x: 0, y: 0 },
                          color: '#ffffff',
                        },
                      }
                )
              );
            }
          });
        }
      );
      const diagnostics = watchBrowserDiagnostics(page);
      const pageErrors: string[] = [];
      page.on('pageerror', (error) => pageErrors.push(error.message));
      await page.goto(`${TestConfig.GAME_URL}?performance=collect`);
      await page.locator('#start-game').click();
      await expect.poll(() => rejected, { timeout: 5000 }).toBe(true);
      await page.locator('#start-screen').waitFor({ state: 'visible' });
      await page.locator('#network-status-banner').waitFor({ state: 'visible' });
      expect(await page.locator('#network-status-banner').textContent()).toContain(
        'Select Enter Game to try again.'
      );
      const failedJoin = await page.evaluate(() => window.georoidsPerformance?.read());
      expect(failedJoin?.counters['joinAttempts']).toBe(1);
      expect(failedJoin?.counters['joinFailures']).toBe(1);
      expect(failedJoin?.pendingJoin).toBe(false);
      expect(failedJoin?.pendingRecovery).toBe(false);
      expect(pageErrors).toEqual([]);
      expect(
        diagnostics.errors.some((message) =>
          message.includes(
            failure === 'rejected'
              ? 'Failed to complete server join'
              : 'Current multiplayer protocol is required'
          )
        )
      ).toBe(true);
      const expectedFailure =
        /Failed to complete server join|Current multiplayer protocol is required|Permanently disconnected|Displayed permanent disconnect banner|WebSocket connection closed/;
      expect(
        [...diagnostics.errors, ...diagnostics.warnings].filter(
          (message) => !expectedFailure.test(message)
        )
      ).toEqual([]);
      await page.screenshot({
        path: screenshotManager.getScreenshotPath(
          `performance-${failure}-join-${viewport.name}.png`
        ),
      });

      diagnostics.errors.length = 0;
      diagnostics.warnings.length = 0;
      await page.locator('#start-game').click();
      const game = new GameInteractions(page);
      await game.waitForGameInitialization();
      await page.waitForFunction(() => window.georoidsPerformance?.read().pendingJoin === false);
      const successfulRetry = await page.evaluate(() => window.georoidsPerformance?.read());
      expect(successfulRetry?.counters['joinAttempts']).toBe(2);
      expect(successfulRetry?.counters['joinFailures']).toBe(1);
      expect(successfulRetry?.pendingRecovery).toBe(false);
      expect(await page.locator('#network-status-banner').isVisible()).toBe(false);
      assertNoBrowserDiagnostics(diagnostics);
    },
    TestConfig.DEFAULT_TIMEOUT
  );
}
