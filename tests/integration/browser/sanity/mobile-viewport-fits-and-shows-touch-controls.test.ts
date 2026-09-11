import { expect, test } from 'vitest';

import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';
import { TestConfig } from '../../utils/test-config';
import { canvasPoint, readTouchControlState } from '../../utils/touch-input';

const { browserManager, screenshotManager } = createBrowserScenarioHooks();

test('title and gameplay stay sharp through density changes without a viewport resize', async () => {
  const page = await browserManager.recreatePage();
  await page.setViewportSize({ width: 800, height: 600 });
  const game = new GameInteractions(page);
  await game.navigateToGame();
  const resizeCount = await page.evaluateHandle(() => {
    const count = { value: 0 };
    window.addEventListener('resize', () => count.value++);
    return count;
  });
  const session = await page.context().newCDPSession(page);
  const setDensity = async (ratio: number): Promise<void> => {
    await session.send('Emulation.setDeviceMetricsOverride', {
      width: 800,
      height: 600,
      deviceScaleFactor: ratio,
      mobile: false,
    });
    // DPR overrides alone do not invalidate Chromium's resolution media queries.
    // Reevaluate native queries without resizing or dispatching application events.
    await session.send('Emulation.setEmulatedMedia', { media: 'screen' });
    await session.send('Emulation.setEmulatedMedia', { media: '' });
  };
  try {
    for (const ratio of [2, 1.5, 2.25]) {
      await setDensity(ratio);
      await page.waitForFunction(
        (dpr) => {
          const title = document.querySelector<HTMLCanvasElement>('#title-terrain');
          const canvas = document.querySelector<HTMLCanvasElement>('#gameCanvas');
          return (
            window.devicePixelRatio === dpr &&
            window.innerWidth === 800 &&
            window.innerHeight === 600 &&
            title?.width === 800 * Math.min(dpr, 2) &&
            title?.height === 600 * Math.min(dpr, 2) &&
            canvas?.width === 800 * dpr &&
            canvas?.height === 600 * dpr
          );
        },
        ratio,
        { timeout: 5000 }
      );
    }
    await game.startGame();
    await game.waitForServerJoin();
    expect(
      await page.evaluate(() => {
        const canvas = document.getElementById('gameCanvas');
        if (!(canvas instanceof HTMLCanvasElement)) {
          throw new Error('Game canvas unavailable');
        }
        const rect = canvas.getBoundingClientRect();
        return { width: rect.width, height: rect.height };
      })
    ).toEqual({ width: 800, height: 600 });
    await setDensity(1.25);
    await page.waitForFunction(
      () => {
        const canvas = document.querySelector<HTMLCanvasElement>('#gameCanvas');
        return canvas?.width === 1000 && canvas?.height === 750;
      },
      undefined,
      { timeout: 5000 }
    );
    expect(
      await page.evaluate(() => {
        const canvas = document.getElementById('gameCanvas');
        if (!(canvas instanceof HTMLCanvasElement)) {
          throw new Error('Game canvas unavailable');
        }
        const rect = canvas.getBoundingClientRect();
        return { width: rect.width, height: rect.height };
      })
    ).toEqual({ width: 800, height: 600 });
    expect(await resizeCount.evaluate((count) => count.value)).toBe(0);
  } finally {
    await session.send('Emulation.clearDeviceMetricsOverride');
    await session.detach();
    await resizeCount.dispose();
  }
});

test(
  'mobile viewport fits chrome and exposes canvas firing, ability, and shield without a movement pad',
  async () => {
    const page = await browserManager.recreatePage({ hasTouch: true });
    if (!page) {
      throw new Error('Page not available');
    }

    await page.setViewportSize({ width: 390, height: 844 });

    const game = new GameInteractions(page);
    await game.bootGame({ waitForCombatReady: false });

    const chrome = await page.evaluate(() => {
      const root = document.getElementById('touch-controls');
      const stick = document.getElementById('touch-stick');
      const ability = document.getElementById('touch-ability');
      const shield = document.getElementById('touch-shield');
      const canvas = document.getElementById('gameCanvas');
      const overflow = document.documentElement.scrollWidth > window.innerWidth + 1;
      const box = (el: Element | null) => {
        if (!el) {
          return null;
        }
        const r = el.getBoundingClientRect();
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
      };
      return {
        inPlay: document.body.classList.contains('in-play'),
        touchPlay: document.body.classList.contains('touch-play'),
        hidden: root?.hidden ?? true,
        overflow,
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        dpr: window.devicePixelRatio,
        canvas: box(canvas),
        stick: box(stick),
        ability: box(ability),
        shield: box(shield),
        abilityDisabled: ability?.getAttribute('aria-disabled'),
        shieldDisabled: shield?.getAttribute('aria-disabled'),
      };
    });

    expect(chrome.inPlay).toBe(true);
    expect(chrome.touchPlay).toBe(true);
    expect(chrome.hidden).toBe(false);
    expect(chrome.overflow).toBe(false);
    expect(chrome.dpr).toBe(2);
    expect(chrome.canvas).toBeTruthy();
    expect(chrome.canvas?.left).toBeGreaterThanOrEqual(-1);
    expect(chrome.canvas?.right).toBeLessThanOrEqual(chrome.innerWidth + 1);
    expect(chrome.canvas?.top).toBeGreaterThanOrEqual(-1);
    expect(chrome.canvas?.bottom).toBeLessThanOrEqual(chrome.innerHeight + 1);
    expect(chrome.stick).toBeNull();
    expect(chrome.ability).toBeTruthy();
    expect(chrome.shield).toBeTruthy();
    expect(chrome.abilityDisabled).toBe('false');
    expect(chrome.shieldDisabled).toBe('false');
    expect(chrome.ability?.right).toBeLessThanOrEqual(chrome.innerWidth + 1);
    expect(chrome.shield?.right).toBeLessThanOrEqual(chrome.innerWidth + 1);
    expect(chrome.ability?.bottom).toBeLessThanOrEqual(chrome.innerHeight + 1);
    expect(chrome.shield?.bottom).toBeLessThanOrEqual(chrome.innerHeight + 1);

    const beforeTap = await readTouchControlState(page);
    const tapPoint = await canvasPoint(page, 0.75, 0.5);
    await page.touchscreen.tap(tapPoint.x, tapPoint.y);
    await game.waitForAnimationFrames(2);
    expect((await readTouchControlState(page)).lastShotTime).toBeGreaterThan(
      beforeTap.lastShotTime
    );

    await page.locator('#touch-ability').click();
    const abilityUsed = await page.evaluate(() => {
      const gc = window as unknown as {
        gameController?: {
          getPlayerManager: () => {
            getLocalPlayer: () => {
              ship: { abilityCooldownFrames: number; abilityActiveFrames: number };
            } | null;
          };
        };
      };
      const ship = gc.gameController?.getPlayerManager().getLocalPlayer()?.ship;
      return Boolean(ship && (ship.abilityCooldownFrames > 0 || ship.abilityActiveFrames > 0));
    });
    expect(abilityUsed).toBe(true);

    await page.locator('#touch-shield').click();
    const shieldRaised = await page.evaluate(() => {
      const gc = window as unknown as {
        gameController?: {
          getPlayerManager: () => {
            getLocalPlayer: () => { ship: { shieldActive: boolean } } | null;
          };
        };
      };
      return Boolean(gc.gameController?.getPlayerManager().getLocalPlayer()?.ship.shieldActive);
    });
    expect(shieldRaised).toBe(true);
  },
  TestConfig.DEFAULT_TIMEOUT
);

test(
  'mobile menu stays inside the viewport before play and after game over',
  async () => {
    const page = await browserManager.recreatePage({ hasTouch: true });
    await page.setViewportSize({ width: 390, height: 844 });
    const game = new GameInteractions(page);
    const assertMenuFits = async (phase: string) => {
      await page.locator('#start-screen').waitFor({ state: 'visible' });
      const menu = await page.locator('#start-screen').evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return {
          left: rect.left,
          right: rect.right,
          width: window.innerWidth,
          scrollWidth: element.scrollWidth,
          clientWidth: element.clientWidth,
        };
      });
      expect(menu.left).toBeGreaterThanOrEqual(0);
      expect(menu.right).toBeLessThanOrEqual(menu.width);
      expect(menu.scrollWidth).toBeLessThanOrEqual(menu.clientWidth + 1);
      await page.screenshot({
        path: screenshotManager.getScreenshotPath(
          screenshotManager.getTimestampedFilename(`mobile-menu-${phase}`)
        ),
      });
    };
    await game.navigateToGame();
    await assertMenuFits('before-play');
    await game.startGame();
    await game.waitForGameReady();
    await game.waitForServerJoin();
    await game.dieUntilGameOver();
    await expect.poll(() => game.isStartScreenVisible(), { timeout: 10000 }).toBe(true);
    await assertMenuFits('after-game-over');
  },
  TestConfig.DEFAULT_TIMEOUT * 3
);
