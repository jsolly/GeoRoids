import { expect, test } from 'vitest';
import { installAudioProbe } from '../../utils/audio-probe';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';

const { browserManager, screenshotManager } = createBrowserScenarioHooks();

test('title Music checkbox loops the lobby bed and Enter Game swaps to the playfield', async () => {
  const page = await browserManager.recreatePage({ music: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  await installAudioProbe(page, true, { music: true });
  const game = new GameInteractions(page);
  await game.navigateToGame();
  await expect
    .poll(() => page.locator('label[for="soundPref"]').textContent())
    .toBe('Sound Effects');
  expect(
    await page.locator('#musicPref').evaluate((input) => {
      return input instanceof HTMLInputElement && input.checked;
    })
  ).toBe(true);
  await expect.poll(() => page.locator('label[for="musicPref"]').textContent()).toBe('Music');
  await page.locator('#start-screen').click({ position: { x: 24, y: 24 } });
  await expect
    .poll(
      async () => {
        const events: Array<{ loop: boolean }> = await page.evaluate(() =>
          JSON.parse(document.documentElement.dataset['audioEvents'] ?? '[]')
        );
        return events.some((event) => event.loop);
      },
      { timeout: 30000 }
    )
    .toBe(true);
  await page.screenshot({
    path: screenshotManager.getScreenshotPath('music-title-desktop.png'),
  });
  const titleLoops = await page.evaluate(() =>
    JSON.parse(document.documentElement.dataset['audioEvents'] ?? '[]').filter(
      (event: { loop: boolean }) => event.loop
    )
  );
  const titleLoop = titleLoops[0] as { duration: number; bufferId: number } | undefined;
  await game.startGame();
  await game.waitForGameReady();
  await expect
    .poll(
      async () => {
        if (!titleLoop) {
          return false;
        }
        const events: Array<{ loop: boolean; duration: number; bufferId: number }> =
          await page.evaluate(() =>
            JSON.parse(document.documentElement.dataset['audioEvents'] ?? '[]')
          );
        return events.some(
          (event) =>
            event.loop &&
            (event.bufferId !== titleLoop.bufferId || event.duration !== titleLoop.duration)
        );
      },
      { timeout: 30000 }
    )
    .toBe(true);
  await page.locator('#musicPref').evaluate((input) => {
    if (!(input instanceof HTMLInputElement)) {
      throw new Error('Music preference checkbox missing');
    }
    input.checked = false;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await expect.poll(() => page.evaluate(() => localStorage.getItem('musicOn'))).toBe('false');
  await expect
    .poll(() => page.evaluate(() => document.documentElement.dataset['activeLoops']), {
      timeout: 10000,
    })
    .toBe('0');
  await page.screenshot({
    path: screenshotManager.getScreenshotPath('music-muted-in-play-desktop.png'),
  });
}, 120000);
