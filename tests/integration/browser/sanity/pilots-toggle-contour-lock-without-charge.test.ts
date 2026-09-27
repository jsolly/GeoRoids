import { expect, test } from 'vitest';
import {
  assertNoBrowserDiagnostics,
  watchBrowserDiagnostics,
} from '../../utils/browser-diagnostics';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { placePilotNearContour } from '../../utils/contour-lock';
import { GameInteractions } from '../../utils/game-interactions';
import { arrangeCrewField } from '../../utils/test-server-control';
import { centerOf, dispatchTouch } from '../../utils/touch-input';

const { browserManager, screenshotManager } = createBrowserScenarioHooks();

for (const viewport of [
  { name: 'desktop', width: 1280, height: 900, touch: false },
  { name: 'mobile', width: 390, height: 844, touch: true },
  { name: 'landscape', width: 844, height: 390, touch: true },
]) {
  test(`a ${viewport.name} pilot catches and releases a contour without a charge meter`, async () => {
    const page = await browserManager.recreatePage({ hasTouch: viewport.touch });
    const diagnostics = watchBrowserDiagnostics(page);
    await page.setViewportSize(viewport);
    const game = new GameInteractions(page);
    await game.bootGame({ waitForCombatReady: false, kitId: 'scout' });
    const observerPage = await browserManager.createAdditionalPage();
    const observerDiagnostics = watchBrowserDiagnostics(observerPage);
    const observer = new GameInteractions(observerPage);
    await observer.bootGame({ waitForCombatReady: false, kitId: 'scout' });
    const playerId = await game.getLocalPlayerId();
    await arrangeCrewField([playerId, await observer.getLocalPlayerId()], 'empty');
    await placePilotNearContour(page, game);
    const button = page.locator('#touch-contour-lock');
    await button.waitFor({ state: 'visible' });
    await expect.poll(() => button.isEnabled()).toBe(true);
    await expect.poll(() => button.textContent()).toBe('CONTOUR LOCK');
    const activate = () => (viewport.touch ? button.tap() : button.click());
    await activate();
    await expect.poll(() => button.getAttribute('aria-pressed')).toBe('true');
    await game.waitForAnimationFrames(90);
    expect(await button.textContent()).toBe('RELEASE LOCK');
    expect(await button.getAttribute('aria-pressed')).toBe('true');
    expect(await button.textContent()).not.toContain('%');
    await expect
      .poll(() =>
        observerPage.evaluate((id) => {
          const ship = window.gameController
            ?.getNetworkManager()
            .getAllPlayers()
            .find((player) => player.id === id)?.ship;
          return Boolean(ship?.contourLock);
        }, playerId)
      )
      .toBe(true);
    // Firing uses real input and must not release the rail.
    const center = await centerOf(page, '#gameCanvas');
    if (viewport.touch) {
      await page.touchscreen.tap(center.x, center.y);
    } else {
      await page.keyboard.press('Space');
    }
    expect(await button.getAttribute('aria-pressed')).toBe('true');
    await page.screenshot({
      path: screenshotManager.getScreenshotPath(`contour-locked-${viewport.name}.png`),
    });
    await activate();
    await expect.poll(() => button.getAttribute('aria-pressed')).toBe('false');
    await activate();
    await expect.poll(() => button.getAttribute('aria-pressed')).toBe('true');
    if (viewport.touch) {
      const session = await page.context().newCDPSession(page);
      try {
        await dispatchTouch(session, 'touchStart', [{ ...center, id: 1 }]);
        await dispatchTouch(session, 'touchMove', [{ x: center.x - 100, y: center.y, id: 1 }]);
        await dispatchTouch(session, 'touchEnd', []);
      } finally {
        await session.detach();
      }
    } else {
      await page.keyboard.press('ArrowLeft');
    }
    await expect.poll(() => button.getAttribute('aria-pressed')).toBe('true');
    await activate();
    await expect.poll(() => button.getAttribute('aria-pressed')).toBe('false');
    await expect
      .poll(() =>
        observerPage.evaluate((id) => {
          const ship = window.gameController
            ?.getNetworkManager()
            .getAllPlayers()
            .find((player) => player.id === id)?.ship;
          return Boolean(ship?.contourLock);
        }, playerId)
      )
      .toBe(false);
    assertNoBrowserDiagnostics(diagnostics);
    assertNoBrowserDiagnostics(observerDiagnostics);
  }, 20000);
}

test('a narrow-phone Debug overlay keeps Contour Lock and the ability disc fully on screen', async () => {
  const page = await browserManager.recreatePage({ hasTouch: true });
  const diagnostics = watchBrowserDiagnostics(page);
  await page.setViewportSize({ width: 390, height: 650 });
  await page.addInitScript(() => localStorage.setItem('debugOn', 'true'));
  const game = new GameInteractions(page);
  await game.bootGame({ waitForCombatReady: false, kitId: 'scout' });
  await placePilotNearContour(page, game);
  const panel = page.locator('#debug-hud');
  const contourLock = page.locator('#touch-contour-lock');
  await panel.waitFor({ state: 'visible' });
  await contourLock.waitFor({ state: 'visible' });
  const ability = page.locator('#touch-ability');
  await ability.waitFor({ state: 'visible' });
  await expect.poll(() => ability.textContent()).toBe('SCAN');
  const chrome = await page.evaluate(() => {
    const box = (el: Element | null) => {
      if (!el) {
        return null;
      }
      const r = el.getBoundingClientRect();
      return {
        left: r.left,
        right: r.right,
        top: r.top,
        bottom: r.bottom,
        width: r.width,
        height: r.height,
      };
    };
    const visualWidth = Math.round(window.visualViewport?.width ?? window.innerWidth);
    const visualHeight = Math.round(window.visualViewport?.height ?? window.innerHeight);
    const abilityEl = document.querySelector('#touch-ability');
    const abilityBox = box(abilityEl);
    const hit =
      abilityBox &&
      document.elementFromPoint(
        abilityBox.left + abilityBox.width / 2,
        abilityBox.top + abilityBox.height / 2
      );
    return {
      visualWidth,
      visualHeight,
      overflowX: document.documentElement.scrollWidth > visualWidth + 1,
      overflowY: document.documentElement.scrollHeight > visualHeight + 1,
      playfield: box(document.querySelector('#gameArea')),
      canvas: box(document.querySelector('#gameCanvas')),
      stack: box(document.querySelector('#debug-play-stack')),
      ability: abilityBox,
      contourLock: box(document.querySelector('#touch-contour-lock')),
      abilityLabel: abilityEl?.textContent,
      abilityHit: hit instanceof Element && Boolean(abilityEl?.contains(hit) || hit === abilityEl),
    };
  });
  const panelBounds = await page.locator('#debug-play-stack').boundingBox();
  const contourLockBounds = await contourLock.boundingBox();
  if (!panelBounds || !contourLockBounds) {
    throw new Error('Missing Debug HUD or Contour Lock bounds');
  }
  await page.screenshot({
    path: screenshotManager.getScreenshotPath('debug-hud-keeps-contour-lock-visible-mobile.png'),
  });
  expect(chrome.abilityLabel).toBe('SCAN');
  expect(chrome.overflowX).toBe(false);
  expect(chrome.overflowY).toBe(false);
  expect(chrome.playfield?.width).toBe(chrome.visualWidth);
  expect(chrome.playfield?.height).toBe(chrome.visualHeight);
  expect(chrome.canvas?.width).toBe(chrome.visualWidth);
  expect(chrome.ability).toBeTruthy();
  expect(chrome.ability?.left).toBeGreaterThanOrEqual((chrome.playfield?.left ?? 0) - 1);
  expect(chrome.ability?.right).toBeLessThanOrEqual((chrome.playfield?.right ?? 0) + 1);
  expect(chrome.ability?.top).toBeGreaterThanOrEqual((chrome.playfield?.top ?? 0) - 1);
  expect(chrome.ability?.bottom).toBeLessThanOrEqual((chrome.playfield?.bottom ?? 0) + 1);
  expect(chrome.ability?.left).toBeGreaterThanOrEqual(-1);
  expect(chrome.ability?.right).toBeLessThanOrEqual(chrome.visualWidth + 1);
  expect(chrome.ability?.bottom).toBeLessThanOrEqual(chrome.visualHeight + 1);
  expect(chrome.abilityHit).toBe(true);
  expect(chrome.stack?.left).toBeGreaterThanOrEqual((chrome.playfield?.left ?? 0) - 1);
  expect(chrome.stack?.right).toBeLessThanOrEqual((chrome.playfield?.right ?? 0) + 1);
  expect(chrome.stack?.top).toBeGreaterThanOrEqual((chrome.playfield?.top ?? 0) - 1);
  expect(chrome.stack?.bottom).toBeLessThanOrEqual((chrome.playfield?.bottom ?? 0) + 1);
  expect(chrome.contourLock?.right).toBeLessThanOrEqual(chrome.ability?.left ?? 0);
  expect(panelBounds.y + panelBounds.height).toBeLessThan(contourLockBounds.y);
  await contourLock.tap();
  await expect.poll(() => contourLock.getAttribute('aria-pressed')).toBe('true');
  assertNoBrowserDiagnostics(diagnostics);
}, 20000);
