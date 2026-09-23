import { expect, test } from 'vitest';
import { installAudioProbe, readSamplePlaybackRates } from '../../utils/audio-probe';
import {
  assertNoBrowserDiagnostics,
  watchBrowserDiagnostics,
} from '../../utils/browser-diagnostics';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';
import { arrangeCrewField } from '../../utils/test-server-control';

const { browserManager, screenshotManager } = createBrowserScenarioHooks();

for (const viewport of [
  { name: 'desktop', width: 1280, height: 900, touch: false },
  { name: 'mobile', width: 390, height: 844, touch: true },
  { name: 'landscape', width: 844, height: 390, touch: true },
]) {
  test(`a ${viewport.name} pilot interrupts cyan recharge with a partial amber boost`, async () => {
    const page = await browserManager.recreatePage({ hasTouch: viewport.touch });
    const diagnostics = watchBrowserDiagnostics(page);
    await page.setViewportSize(viewport);
    await installAudioProbe(page);
    const game = new GameInteractions(page);
    await game.bootGame({ waitForCombatReady: false, kitId: 'scout' });
    const id = await page.evaluate(() => window.gameController?.getCurrPlayer()?.id);
    if (!id) {
      throw new Error('Missing pilot');
    }
    await arrangeCrewField([id], 'empty');
    await game.waitForAnimationFrames(4);
    const button = page.locator('#touch-boost');
    await button.waitFor({ state: 'visible' });
    await expect.poll(() => button.isEnabled()).toBe(true);
    const activate = () => (viewport.touch ? button.tap() : button.click());
    await activate();
    await page.waitForFunction(() => {
      const boost = window.gameController?.getCurrPlayer()?.ship.boost;
      return boost?.phase === 'active' && boost.charge < 0.65 && boost.charge > 0.3;
    });
    expect(await button.getAttribute('aria-pressed')).toBe('true');
    const activeColor = await button.evaluate((el) =>
      getComputedStyle(el).getPropertyValue('--boost-fill').trim()
    );
    expect(activeColor).toBe('#fbbf24');
    const beforeCharge = Number(await button.getAttribute('data-boost-charge'));
    await game.waitForAnimationFrames(6);
    expect(Number(await button.getAttribute('data-boost-charge'))).toBeLessThan(beforeCharge);
    await page.screenshot({
      path: screenshotManager.getScreenshotPath(`boost-active-${viewport.name}.png`),
    });
    await page.waitForFunction(
      () => window.gameController?.getCurrPlayer()?.ship.boost.phase === 'exhausted',
      undefined,
      { timeout: 5000 }
    );
    await page.waitForFunction(() => {
      const boost = window.gameController?.getCurrPlayer()?.ship.boost;
      return boost?.phase === 'exhausted' && boost.charge > 0.4 && boost.charge < 0.75;
    });
    expect(await button.getAttribute('aria-pressed')).toBe('false');
    expect(await readSamplePlaybackRates(page, 'boost-start')).toEqual([1]);
    expect(await readSamplePlaybackRates(page, 'boost-end')).toEqual([1]);
    expect(
      await button.evaluate((el) => getComputedStyle(el).getPropertyValue('--boost-fill').trim())
    ).toBe('#22d3ee');
    const refilling = Number(await button.getAttribute('data-boost-charge'));
    await game.waitForAnimationFrames(6);
    expect(Number(await button.getAttribute('data-boost-charge'))).toBeGreaterThan(refilling);
    await page.screenshot({
      path: screenshotManager.getScreenshotPath(`boost-refilling-${viewport.name}.png`),
    });
    await expect.poll(() => button.isEnabled()).toBe(true);
    await activate();
    await expect.poll(() => button.getAttribute('aria-pressed')).toBe('true');
    const partial = Number(await button.getAttribute('data-boost-charge'));
    expect(partial).toBeLessThan(0.8);
    await game.waitForAnimationFrames(12);
    expect(await button.getAttribute('data-boost-phase')).toBe('active');
    expect(Number(await button.getAttribute('data-boost-charge'))).toBeLessThan(partial);
    expect(
      await button.evaluate((el) => getComputedStyle(el).getPropertyValue('--boost-fill').trim())
    ).toBe('#fbbf24');
    await page.screenshot({
      path: screenshotManager.getScreenshotPath(`boost-partial-restart-${viewport.name}.png`),
    });
    await activate();
    await expect.poll(() => button.getAttribute('aria-pressed')).toBe('false');
    await page.waitForFunction(
      () => {
        const boost = window.gameController?.getCurrPlayer()?.ship.boost;
        return boost?.phase === 'idle' && boost.charge === 1;
      },
      undefined,
      { timeout: 6000 }
    );
    await expect.poll(() => button.isEnabled()).toBe(true);
    await activate();
    await expect
      .poll(() => page.evaluate(() => window.gameController?.getCurrPlayer()?.ship.boosting))
      .toBe(true);
    await activate();
    await expect
      .poll(() => page.evaluate(() => window.gameController?.getCurrPlayer()?.ship.boosting))
      .toBe(false);
    assertNoBrowserDiagnostics(diagnostics);
  }, 20000);
}

test('a narrow-phone Debug overlay keeps boost and the ability disc fully on screen', async () => {
  const page = await browserManager.recreatePage({ hasTouch: true });
  const diagnostics = watchBrowserDiagnostics(page);
  await page.setViewportSize({ width: 390, height: 650 });
  await page.addInitScript(() => localStorage.setItem('debugOn', 'true'));
  const game = new GameInteractions(page);
  await game.bootGame({ waitForCombatReady: false, kitId: 'scout' });
  await game.placeShipAt(0, -500);
  const panel = page.locator('#debug-hud');
  const boost = page.locator('#touch-boost');
  await panel.waitFor({ state: 'visible' });
  await boost.waitFor({ state: 'visible' });
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
      boost: box(document.querySelector('#touch-boost')),
      abilityLabel: abilityEl?.textContent,
      abilityHit: hit instanceof Element && Boolean(abilityEl?.contains(hit) || hit === abilityEl),
    };
  });
  const panelBounds = await page.locator('#debug-play-stack').boundingBox();
  const boostBounds = await boost.boundingBox();
  if (!panelBounds || !boostBounds) {
    throw new Error('Missing Debug HUD or boost bounds');
  }
  await page.screenshot({
    path: screenshotManager.getScreenshotPath('debug-hud-keeps-boost-visible-mobile.png'),
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
  expect(chrome.boost?.right).toBeLessThanOrEqual(chrome.ability?.left ?? 0);
  expect(panelBounds.y + panelBounds.height).toBeLessThan(boostBounds.y);
  await boost.tap();
  await expect.poll(() => boost.getAttribute('aria-pressed')).toBe('true');
  assertNoBrowserDiagnostics(diagnostics);
}, 20000);
