import { expect, test } from 'vitest';
import {
  assertNoBrowserDiagnostics,
  watchBrowserDiagnostics,
} from '../../utils/browser-diagnostics';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';
import { TestConfig } from '../../utils/test-config';
import {
  centerOf,
  dispatchTouch,
  readTouchControlLayout,
  readTouchControlState,
} from '../../utils/touch-input';

const { browserManager, screenshotManager } = createBrowserScenarioHooks(__dirname);

function assertLayoutFitsViewport(
  layout: Awaited<ReturnType<typeof readTouchControlLayout>>
): void {
  expect(layout.overflow).toBe(false);
  expect(layout.canvas?.width).toBeGreaterThan(0);
  expect(layout.canvas?.height).toBeGreaterThan(0);
  for (const [name, control] of [
    ['stick', layout.stick],
    ['fire', layout.fire],
    ['ability', layout.ability],
    ['shield', layout.shield],
  ] as const) {
    if (!control) {
      throw new Error(`${name} touch control is missing after resize`);
    }
    expect(control.left, `${name} should stay inside the left edge`).toBeGreaterThanOrEqual(-1);
    expect(control.right, `${name} should stay inside the right edge`).toBeLessThanOrEqual(
      layout.viewport.width + 1
    );
    expect(control.top, `${name} should stay inside the top edge`).toBeGreaterThanOrEqual(-1);
    expect(control.bottom, `${name} should stay inside the bottom edge`).toBeLessThanOrEqual(
      layout.viewport.height + 1
    );
  }
}

test(
  'a mobile pilot sustains steer and fire, uses ability and shield, then releases on resize and cancellation',
  async () => {
    await browserManager.recreatePage({ hasTouch: true });
    const page = browserManager.getCurrentPage();
    if (!page) {
      throw new Error('Page not available');
    }
    const diagnostics = watchBrowserDiagnostics(page);
    const game = new GameInteractions(page);

    await page.setViewportSize({ width: 390, height: 844 });
    await game.bootGame({ waitForCombatReady: false, kitId: 'dart' });
    await page.waitForFunction(
      () =>
        document.body.classList.contains('touch-play') &&
        document.getElementById('touch-controls')?.hidden === false,
      undefined,
      { timeout: 5000 }
    );

    const stick = await centerOf(page, '#touch-stick');
    const fire = await centerOf(page, '#touch-fire');
    const ability = await centerOf(page, '#touch-ability');
    const shield = await centerOf(page, '#touch-shield');
    const session = await page.context().newCDPSession(page);
    const beforeHold = await readTouchControlState(page);

    await dispatchTouch(session, 'touchStart', [
      { x: stick.x + 42, y: stick.y, id: 11 },
      { x: fire.x, y: fire.y, id: 12 },
    ]);
    await game.waitForAnimationFrames(60);
    await dispatchTouch(session, 'touchMove', [
      { x: stick.x + 48, y: stick.y - 6, id: 11 },
      { x: fire.x, y: fire.y, id: 12 },
    ]);
    await game.waitForAnimationFrames(60);

    const duringHold = await readTouchControlState(page);
    expect(duringHold.thrusting).toBe(true);
    expect(duringHold.lastShotTime).toBeGreaterThan(beforeHold.lastShotTime);
    expect(
      Math.hypot(
        duringHold.position.x - beforeHold.position.x,
        duringHold.position.y - beforeHold.position.y
      )
    ).toBeGreaterThan(5);
    expect(
      await page
        .locator('#touch-fire')
        .evaluate((element) => element.classList.contains('is-pressed'))
    ).toBe(true);

    const held = [
      { x: stick.x + 48, y: stick.y - 6, id: 11 },
      { x: fire.x, y: fire.y, id: 12 },
    ];
    await dispatchTouch(session, 'touchStart', [...held, { ...ability, id: 13 }]);
    await dispatchTouch(session, 'touchMove', held);
    await game.waitForAnimationFrames(2);
    const afterAbility = await readTouchControlState(page);
    expect(afterAbility.abilityCooldownFrames).toBeGreaterThan(0);
    expect(afterAbility.thrusting).toBe(true);
    expect(
      await page
        .locator('#touch-fire')
        .evaluate((element) => element.classList.contains('is-pressed'))
    ).toBe(true);

    await dispatchTouch(session, 'touchStart', [...held, { ...shield, id: 14 }]);
    await dispatchTouch(session, 'touchMove', held);
    await game.waitForAnimationFrames(2);
    const afterShield = await readTouchControlState(page);
    expect(afterShield.shieldActive).toBe(true);
    expect(afterShield.thrusting).toBe(true);
    expect(
      await page
        .locator('#touch-fire')
        .evaluate((element) => element.classList.contains('is-pressed'))
    ).toBe(true);

    await dispatchTouch(session, 'touchCancel', []);
    await game.waitForAnimationFrames(2);
    const afterCancel = await readTouchControlState(page);
    expect(afterCancel.thrusting).toBe(false);
    expect(afterCancel.canShoot).toBe(true);
    expect(
      await page
        .locator('#touch-fire')
        .evaluate((element) => element.classList.contains('is-pressed'))
    ).toBe(false);

    await page.screenshot({
      path: screenshotManager.getScreenshotPath('performance-mobile-portrait.png'),
    });

    const portraitStick = await centerOf(page, '#touch-stick');
    const portraitFire = await centerOf(page, '#touch-fire');
    await dispatchTouch(session, 'touchStart', [
      { x: portraitStick.x + 42, y: portraitStick.y, id: 21 },
      { x: portraitFire.x, y: portraitFire.y, id: 22 },
    ]);
    await game.waitForAnimationFrames(6);
    expect((await readTouchControlState(page)).thrusting).toBe(true);

    await page.setViewportSize({ width: 844, height: 390 });
    await page.evaluate(() => window.dispatchEvent(new Event('orientationchange')));
    await game.waitForAnimationFrames(2);

    const afterResize = await readTouchControlState(page);
    expect(afterResize.thrusting).toBe(false);
    expect(afterResize.canShoot).toBe(true);
    expect(
      await page
        .locator('#touch-fire')
        .evaluate((element) => element.classList.contains('is-pressed'))
    ).toBe(false);
    expect(await page.locator('#touch-stick-knob').getAttribute('style')).toBe(
      'transform: translate(-50%, -50%);'
    );
    assertLayoutFitsViewport(await readTouchControlLayout(page));

    await page.screenshot({
      path: screenshotManager.getScreenshotPath('performance-mobile-landscape.png'),
    });
    assertNoBrowserDiagnostics(diagnostics);
  },
  TestConfig.DEFAULT_TIMEOUT * 2
);
