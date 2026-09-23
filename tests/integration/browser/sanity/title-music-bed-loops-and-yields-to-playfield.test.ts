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

async function expectAudioControlsReachable(page: Page, mobile: boolean): Promise<void> {
  const layout = await page.evaluate(() => {
    const controls = [
      'restart-audio-play',
      'ship-schematic-toggle',
      'universe-map-toggle',
      'touch-boost',
      'touch-ability',
      'debug-hud-toggle',
      'copy-debug-diagnostics',
    ].flatMap((id) => {
      const element = document.querySelector(`#${id}`);
      const rect = element?.getBoundingClientRect();
      if (!element || !rect || rect.width === 0 || rect.height === 0) {
        return [];
      }
      const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
      return [
        {
          id,
          left: rect.left,
          right: rect.right,
          top: rect.top,
          bottom: rect.bottom,
          height: rect.height,
          reachable: hit === element || (hit !== null && element.contains(hit)),
        },
      ];
    });
    return {
      controls,
      width: innerWidth,
      height: innerHeight,
      openCanvas: [0.25, 0.6].every(
        (x) => document.elementFromPoint(innerWidth * x, innerHeight * 0.85)?.id === 'gameCanvas'
      ),
    };
  });
  const restart = layout.controls.find(({ id }) => id === 'restart-audio-play');
  expect(restart).toBeDefined();
  expect(restart?.height).toBeGreaterThanOrEqual(44);
  if (mobile) {
    expect(restart?.bottom).toBeLessThan(layout.height / 2);
    expect(layout.openCanvas).toBe(true);
  }
  for (const [index, control] of layout.controls.entries()) {
    expect(control.reachable, `${control.id} must receive its own taps`).toBe(true);
    expect(control.left).toBeGreaterThanOrEqual(0);
    expect(control.right).toBeLessThanOrEqual(layout.width);
    expect(control.top).toBeGreaterThanOrEqual(0);
    expect(control.bottom).toBeLessThanOrEqual(layout.height);
    for (const other of layout.controls.slice(index + 1)) {
      expect(
        control.left >= other.right ||
          other.left >= control.right ||
          control.top >= other.bottom ||
          other.top >= control.bottom,
        `${control.id} must not overlap ${other.id}`
      ).toBe(true);
    }
  }
}

for (const browserType of [chromium, webkit]) {
  describe(browserType.name(), () => {
    const { browserManager, screenshotManager } = createBrowserScenarioHooks(
      undefined,
      browserType
    );
    for (const viewport of [
      { name: 'desktop', width: 1280, height: 900 },
      { name: 'mobile', width: 390, height: 630 },
      { name: 'landscape', width: 844, height: 390 },
    ]) {
      test(`${viewport.name} pilot restarts title and flight music without changing the flight or preferences`, async () => {
        const mobile = viewport.name !== 'desktop';
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
        await expectAudioControlsReachable(page, mobile);
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
        const debugScreenshots: string[] = [];
        await page.evaluate(
          "import('/src/ui/debugIdentity.ts').then(({applyDebugPreference}) => applyDebugPreference(true))"
        );
        for (const debugState of ['expanded', 'collapsed']) {
          const toggle = page.locator('#debug-hud-toggle');
          if ((await toggle.getAttribute('aria-expanded')) !== String(debugState === 'expanded')) {
            if (mobile) {
              await toggle.tap();
            } else {
              await toggle.click();
            }
          }
          await expectAudioControlsReachable(page, mobile);
          const screenshot = screenshotManager.getScreenshotPath(
            `audio-restart-debug-${debugState}-${browserType.name()}-${viewport.name}.png`
          );
          await page.screenshot({ path: screenshot });
          debugScreenshots.push(screenshot);
        }
        await page.evaluate(
          "import('/src/ui/debugIdentity.ts').then(({applyDebugPreference}) => applyDebugPreference(false))"
        );
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
        await page
          .getByText('If sound stops, use Restart audio', { exact: false })
          .scrollIntoViewIfNeeded();
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
              debugScreenshots,
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
