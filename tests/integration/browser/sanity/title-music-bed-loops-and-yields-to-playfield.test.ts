import { writeFileSync } from 'node:fs';
import { chromium, type Page, webkit } from 'playwright';
import { describe, expect, test } from 'vitest';
import { installAudioProbe } from '../../utils/audio-probe';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';
import { readTouchControlState } from '../../utils/touch-input';

function readLoops(page: Page): Promise<Array<{ duration: number; contextId: number }>> {
  return page.evaluate(() => {
    const events: Array<{ loop: boolean; duration: number; contextId: number }> = JSON.parse(
      document.documentElement.dataset['audioEvents'] ?? '[]'
    );
    return events.filter((event) => event.loop);
  });
}

async function expectOnlyCurrentLoop(page: Page, count: number): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => document.documentElement.dataset['audioContexts']))
    .toBe(String(count));
  await expect
    .poll(() => page.evaluate(() => document.documentElement.dataset['audioContextStates']))
    .toBe(JSON.stringify([...Array.from({ length: count - 1 }, () => 'closed'), 'running']));
  await expect
    .poll(() => page.evaluate(() => document.documentElement.dataset['activeLoopContexts']), {
      timeout: 30000,
    })
    .toBe(JSON.stringify([count]));
}

for (const browserType of [chromium, webkit]) {
  describe(browserType.name(), () => {
    const { browserManager, screenshotManager } = createBrowserScenarioHooks(
      undefined,
      browserType
    );
    for (const viewport of [
      { name: 'desktop', width: 1280, height: 900 },
      { name: 'mobile', width: 390, height: 844 },
    ]) {
      test(`${viewport.name} pilot restarts title and flight music without changing the flight or preferences`, async () => {
        const mobile = viewport.name === 'mobile';
        const page = await browserManager.recreatePage({ music: true, hasTouch: mobile });
        await page.setViewportSize(viewport);
        await installAudioProbe(page, true, { music: true });
        const errors: string[] = [];
        const warnings: string[] = [];
        const gameplaySockets: string[] = [];
        page.on('pageerror', (error) => errors.push(error.message));
        page.on('console', (message) => {
          if (message.type() === 'error') {
            errors.push(message.text());
          }
          if (message.type() === 'warning') {
            warnings.push(message.text());
          }
        });
        page.on('websocket', (socket) => {
          if (new URL(socket.url()).pathname === '/ws') {
            gameplaySockets.push(socket.url());
          }
        });
        const game = new GameInteractions(page);
        await game.navigateToGame();
        expect(await page.locator('label[for="soundPref"]').textContent()).toBe('Sound Effects');
        expect(await page.locator('#musicPref').isChecked()).toBe(true);
        expect(await page.locator('label[for="musicPref"]').textContent()).toBe('Music');
        await page.locator('#ship-kit-grid [aria-pressed="true"]').click();
        await expectOnlyCurrentLoop(page, 1);
        const titleLoop = (await readLoops(page)).at(-1);
        expect(titleLoop).toBeDefined();

        const menuRestart = page.locator('#restart-audio-menu');
        if (mobile) {
          await menuRestart.tap();
        } else {
          await menuRestart.click();
        }
        await expectOnlyCurrentLoop(page, 2);
        expect((await readLoops(page)).at(-1)?.duration).toBe(titleLoop?.duration);
        expect(await page.locator('#audio-status-menu').textContent()).toBe(
          'Audio restart requested'
        );
        const titleScreenshot = screenshotManager.getScreenshotPath(
          `audio-restart-title-${browserType.name()}-${viewport.name}.png`
        );
        await page.screenshot({ path: titleScreenshot, fullPage: true });

        await game.startGame();
        await game.waitForGameReady();
        await game.waitForCombatReady();
        await expect
          .poll(async () => (await readLoops(page)).at(-1)?.duration, { timeout: 30000 })
          .not.toBe(titleLoop?.duration);
        await expectOnlyCurrentLoop(page, 2);
        const flightLoop = (await readLoops(page)).at(-1);
        const playerId = await game.getLocalPlayerId();
        const beforeInput = await readTouchControlState(page);
        const socketsBefore = gameplaySockets.length;
        expect(socketsBefore).toBe(1);
        expect(
          await page.locator('body').evaluate((body) => body.classList.contains('debug-on'))
        ).toBe(false);
        const playRestart = page.locator('#restart-audio-play');
        const restartBox = await playRestart.boundingBox();
        const boostBox = await page.locator('#touch-boost').boundingBox();
        if (!restartBox || !boostBox) {
          throw new Error('Audio and Boost controls must be visible');
        }
        expect(restartBox.height).toBeGreaterThanOrEqual(44);
        expect(restartBox.x).toBeGreaterThanOrEqual(0);
        expect(restartBox.x + restartBox.width).toBeLessThanOrEqual(viewport.width);
        expect(restartBox.y + restartBox.height).toBeLessThanOrEqual(boostBox.y);
        if (mobile) {
          await playRestart.tap();
        } else {
          await playRestart.focus();
          await page.keyboard.press('Space');
        }
        await expectOnlyCurrentLoop(page, 3);
        expect((await readLoops(page)).at(-1)?.duration).toBe(flightLoop?.duration);
        expect(await page.locator('#audio-status-play').textContent()).toBe(
          'Audio restart requested'
        );
        expect(await game.getLocalPlayerId()).toBe(playerId);
        expect(gameplaySockets.length).toBe(socketsBefore);
        expect(
          await page.evaluate(() => window.gameController?.getNetworkManager().isConnected)
        ).toBe(true);
        expect(
          await page.evaluate(() => ({
            sound: localStorage.getItem('soundOn'),
            music: localStorage.getItem('musicOn'),
          }))
        ).toEqual({ sound: 'true', music: 'true' });
        const afterInput = await readTouchControlState(page);
        expect(afterInput.lastShotTime).toBe(beforeInput.lastShotTime);
        expect(afterInput.thrusting).toBe(true);
        const flightScreenshot = screenshotManager.getScreenshotPath(
          `audio-restart-play-${browserType.name()}-${viewport.name}.png`
        );
        await page.screenshot({ path: flightScreenshot });
        expect(errors).toEqual([]);
        expect(warnings).toEqual([]);

        // Inject only the observed clock stall. Playback remains native Web Audio.
        await page.evaluate(() => {
          document.documentElement.dataset['freezeAudioContext'] = '3';
        });
        await expect
          .poll(
            () =>
              page.evaluate(`(async () => {
      const { readAudioDiagnostics } = await import('/src/audio/audioRuntime.ts');
      return readAudioDiagnostics().clockProgress;
    })()`),
            { timeout: 10000 }
          )
          .toBe('stalled');
        expect(await page.evaluate(() => document.documentElement.dataset['audioContexts'])).toBe(
          '3'
        );
        await page.evaluate(() => {
          document.dispatchEvent(new Event('pointerdown'));
          document.dispatchEvent(new Event('keydown'));
        });
        expect(await page.evaluate(() => document.documentElement.dataset['audioContexts'])).toBe(
          '3'
        );
        if (mobile) {
          await page.locator('#gameCanvas').tap({ position: { x: 180, y: 350 } });
        } else {
          await page.locator('#universe-map-toggle').focus();
          await page.keyboard.press('Tab');
        }
        await expectOnlyCurrentLoop(page, 4);
        expect((await readLoops(page)).at(-1)?.duration).toBe(flightLoop?.duration);
        expect(await game.getLocalPlayerId()).toBe(playerId);
        expect(gameplaySockets.length).toBe(socketsBefore);

        // The title setting is hidden during flight; exercise its real change handler.
        await page.locator('#musicPref').evaluate((input) => {
          if (!(input instanceof HTMLInputElement)) {
            throw new Error('Music preference checkbox missing');
          }
          input.checked = false;
          input.dispatchEvent(new Event('change', { bubbles: true }));
        });
        await expect.poll(() => page.evaluate(() => localStorage.getItem('musicOn'))).toBe('false');
        await expect
          .poll(() => page.evaluate(() => document.documentElement.dataset['activeLoops']))
          .toBe('0');
        await page.goto(new URL('/wiki/#hud-network', page.url()).href);
        await expect.poll(() => page.locator('body').textContent()).toContain('Restart audio');
        await page.getByText('Restart audio', { exact: true }).scrollIntoViewIfNeeded();
        const wikiScreenshot = screenshotManager.getScreenshotPath(
          `audio-restart-wiki-${browserType.name()}-${viewport.name}.png`
        );
        await page.screenshot({ path: wikiScreenshot });
        writeFileSync(
          screenshotManager.getScreenshotPath(
            `audio-restart-${browserType.name()}-${viewport.name}-receipt.json`
          ),
          JSON.stringify(
            {
              routes: ['/', '/wiki/#hud-network'],
              titleScreenshot,
              flightScreenshot,
              wikiScreenshot,
              playerId,
              socketsBefore,
              errors,
              warnings,
            },
            null,
            2
          )
        );
        expect(errors).toEqual([]);
        expect(warnings).toEqual([
          expect.stringContaining('Audio clock stalled; next gesture will restart audio'),
        ]);
      }, 120000);
    }
  });
}
