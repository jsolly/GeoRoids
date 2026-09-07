import { expect, test } from 'vitest';

import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';
import { TestConfig } from '../../utils/test-config';

const { browserManager, screenshotManager } = createBrowserScenarioHooks(__dirname);

test('mobile viewport fits chrome and exposes stick, fire, ability, and shield', async () => {
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
    const fire = document.getElementById('touch-fire');
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
      canvas: canvas ? { width: (canvas as HTMLCanvasElement).width, height: (canvas as HTMLCanvasElement).height } : null,
      stick: box(stick),
      fire: box(fire),
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
  expect(chrome.canvas?.width).toBeGreaterThan(0);
  expect(chrome.canvas?.height).toBeGreaterThan(0);
  expect(chrome.stick).toBeTruthy();
  expect(chrome.fire).toBeTruthy();
  expect(chrome.ability).toBeTruthy();
  expect(chrome.shield).toBeTruthy();
  expect(chrome.abilityDisabled).toBe('false');
  expect(chrome.shieldDisabled).toBe('false');
  expect(chrome.stick?.left).toBeGreaterThanOrEqual(-1);
  expect(chrome.fire?.right).toBeLessThanOrEqual(chrome.innerWidth + 1);
  expect(chrome.ability?.right).toBeLessThanOrEqual(chrome.innerWidth + 1);
  expect(chrome.shield?.right).toBeLessThanOrEqual(chrome.innerWidth + 1);
  expect(chrome.stick?.bottom).toBeLessThanOrEqual(chrome.innerHeight + 1);
  expect(chrome.fire?.bottom).toBeLessThanOrEqual(chrome.innerHeight + 1);
  expect(chrome.ability?.bottom).toBeLessThanOrEqual(chrome.innerHeight + 1);
  expect(chrome.shield?.bottom).toBeLessThanOrEqual(chrome.innerHeight + 1);

  await page.touchscreen.tap(
    Math.round((chrome.fire?.left ?? 0) + 20),
    Math.round((chrome.fire?.top ?? 0) + 20)
  );

  const fired = await page.evaluate(() => {
    const gc = window as unknown as {
      gameController?: {
        getPlayerManager: () => {
          getLocalPlayer: () => { ship: { lasers: unknown[]; lastShotTime: number } } | null;
        };
      };
    };
    const ship = gc.gameController?.getPlayerManager().getLocalPlayer()?.ship;
    return Boolean(ship && (ship.lasers.length > 0 || ship.lastShotTime > 0));
  });
  expect(fired).toBe(true);

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
}, TestConfig.DEFAULT_TIMEOUT);


test('mobile menu stays inside the viewport before play and after game over', async () => {
  const page = await browserManager.recreatePage({ hasTouch: true });
  await page.setViewportSize({ width: 390, height: 844 });
  const game = new GameInteractions(page);
  const assertMenuFits = async (phase: string) => {
    await page.locator('#start-screen').waitFor({ state: 'visible' });
    const menu = await page.locator('#start-screen').evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, right: rect.right, width: window.innerWidth,
        scrollWidth: element.scrollWidth, clientWidth: element.clientWidth };
    });
    expect(menu.left).toBeGreaterThanOrEqual(0);
    expect(menu.right).toBeLessThanOrEqual(menu.width);
    expect(menu.scrollWidth).toBeLessThanOrEqual(menu.clientWidth + 1);
    await page.screenshot({ path: screenshotManager.getScreenshotPath(
      screenshotManager.getTimestampedFilename(`mobile-menu-${phase}`)) });
  };
  await game.navigateToGame();
  await assertMenuFits('before-play');
  await game.startGame();
  await game.waitForGameReady();
  await game.waitForServerJoin();
  await game.dieUntilGameOver();
  await expect.poll(() => game.isStartScreenVisible(), { timeout: 10000 }).toBe(true);
  await assertMenuFits('after-game-over');
}, TestConfig.DEFAULT_TIMEOUT * 3);
