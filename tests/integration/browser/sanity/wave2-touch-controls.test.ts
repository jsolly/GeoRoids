import { existsSync } from 'node:fs';
import type { CDPSession } from 'playwright';
import { expect, test } from 'vitest';

import { watchBrowserDiagnostics } from '../../utils/browser-diagnostics';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';
import { TestConfig } from '../../utils/test-config';
import { arrangeCrewField } from '../../utils/test-server-control';
import {
  canvasPoint,
  centerOf,
  dispatchTouch,
  readTouchControlState as readLocalTouchState,
  type TouchPoint,
} from '../../utils/touch-input';

const { browserManager, screenshotManager } = createBrowserScenarioHooks(__dirname);

const KITS = [
  { kitId: 'surveyor' as const, label: 'SCAN', name: 'Mineral scan' },
  { kitId: 'hauler' as const, label: 'TAP', name: 'Harpoon' },
];

async function tapTouchPoint(
  session: CDPSession,
  heldPoints: TouchPoint[],
  touchPoint: TouchPoint
): Promise<void> {
  // Preserve the active steering/fire contacts while Chromium delivers the
  // changed third contact. This keeps the continuous controls under test.
  await dispatchTouch(session, 'touchMove', heldPoints);
  await dispatchTouch(session, 'touchStart', [touchPoint]);
  await dispatchTouch(session, 'touchEnd', [touchPoint]);
  await dispatchTouch(session, 'touchMove', heldPoints);
}

test(
  'touch steering turns toward the finger and keeps flying after release',
  async () => {
    const page = await browserManager.recreatePage({ hasTouch: true });
    if (!page) {
      throw new Error('Page not available');
    }
    await page.setViewportSize({ width: 390, height: 844 });
    const diagnostics = watchBrowserDiagnostics(page);
    const game = new GameInteractions(page);
    await game.bootGame({ waitForCombatReady: false, kitId: 'hauler' });
    const center = await centerOf(page, '#gameCanvas');
    const session = await page.context().newCDPSession(page);
    let touchActive = false;
    try {
      // A finger resting over the hull must not turn tiny offsets into a new heading.
      const restingAngle = await game.getShipAngle();
      await dispatchTouch(session, 'touchStart', [{ x: center.x + 2, y: center.y - 2, id: 1 }]);
      touchActive = true;
      await game.waitForAnimationFrames(8);
      expect(await game.getShipAngle()).toBeCloseTo(restingAngle, 6);
      await page.screenshot({
        path: screenshotManager.getScreenshotPath('cruise-mobile-resting-finger.png'),
      });
      await dispatchTouch(session, 'touchEnd', []);
      touchActive = false;
      const points = [
        { x: center.x + 100, y: center.y, angle: 0 },
        { x: center.x, y: center.y - 100, angle: Math.PI / 2 },
        { x: center.x - 100, y: center.y, angle: -Math.PI },
        { x: center.x, y: center.y + 100, angle: -Math.PI / 2 },
      ];
      for (const [index, point] of points.entries()) {
        await dispatchTouch(session, index === 0 ? 'touchStart' : 'touchMove', [
          { x: point.x, y: point.y, id: 1 },
        ]);
        touchActive = true;
        await page.waitForFunction(() => window.gameController?.getCurrPlayer()?.ship.thrusting);
        expect((await readLocalTouchState(page)).thrusting).toBe(true);
        await page.waitForFunction((desired) => {
          const angle = window.gameController?.getCurrPlayer()?.ship.angle;
          return (
            angle !== undefined &&
            Math.abs(Math.atan2(Math.sin(angle - desired), Math.cos(angle - desired))) < 0.001
          );
        }, point.angle);
      }
      const beforeRelease = await game.getShipPosition();
      const releaseAngle = await game.getShipAngle();
      await dispatchTouch(session, 'touchEnd', []);
      touchActive = false;
      await game.waitForAnimationFrames(12);
      const afterRelease = await game.getShipPosition();
      expect(
        Math.hypot(afterRelease.x - beforeRelease.x, afterRelease.y - beforeRelease.y)
      ).toBeGreaterThan(5);
      expect(await game.getShipAngle()).toBeCloseTo(releaseAngle, 6);
      expect((await readLocalTouchState(page)).thrusting).toBe(true);
      expect(await page.locator('#touch-stick').count()).toBe(0);
      expect(diagnostics).toEqual({ errors: [], warnings: [] });
    } finally {
      try {
        if (touchActive) {
          await dispatchTouch(session, 'touchCancel', []);
        }
      } finally {
        await session.detach();
      }
    }
  },
  TestConfig.DEFAULT_TIMEOUT
);

test(
  'a quick one-finger canvas tap fires on release while automatic thrust continues',
  async () => {
    const page = await browserManager.recreatePage({ hasTouch: true });
    if (!page) {
      throw new Error('Page not available');
    }
    await page.setViewportSize({ width: 390, height: 844 });
    const diagnostics = watchBrowserDiagnostics(page);
    const game = new GameInteractions(page);
    await game.bootGame({ waitForCombatReady: false, kitId: 'surveyor' });
    const tapPoint = await canvasPoint(page, 0.75, 0.5);
    const session = await page.context().newCDPSession(page);
    let touchActive = false;
    try {
      const beforeTap = await readLocalTouchState(page);
      await dispatchTouch(session, 'touchStart', [{ ...tapPoint, id: 1 }]);
      touchActive = true;
      await game.waitForAnimationFrames(2);
      const duringTap = await readLocalTouchState(page);
      expect(duringTap.thrusting).toBe(true);
      expect(duringTap.lastShotTime).toBe(beforeTap.lastShotTime);

      await dispatchTouch(session, 'touchEnd', []);
      touchActive = false;
      await game.waitForAnimationFrames(2);
      const afterTap = await readLocalTouchState(page);
      expect(afterTap.lastShotTime).toBeGreaterThan(beforeTap.lastShotTime);
      expect(afterTap.thrusting).toBe(true);
      expect(afterTap.canShoot).toBe(true);
      expect(diagnostics).toEqual({ errors: [], warnings: [] });
    } finally {
      try {
        if (touchActive) {
          await dispatchTouch(session, 'touchCancel', []);
        }
      } finally {
        await session.detach();
      }
    }
  },
  TestConfig.DEFAULT_TIMEOUT
);

test(
  'the ability button consumes a pending steering tap without firing',
  async () => {
    const page = await browserManager.recreatePage({ hasTouch: true });
    if (!page) {
      throw new Error('Page not available');
    }
    await page.setViewportSize({ width: 390, height: 844 });
    const diagnostics = watchBrowserDiagnostics(page);
    const game = new GameInteractions(page);
    await game.bootGame({ waitForCombatReady: false, kitId: 'surveyor' });
    const steerPoint = await canvasPoint(page, 0.75, 0.5);
    const actionPoint = await centerOf(page, '#touch-ability');
    const session = await page.context().newCDPSession(page);
    let touchActive = false;
    try {
      const beforeAction = await readLocalTouchState(page);
      await dispatchTouch(session, 'touchStart', [{ ...steerPoint, id: 21 }]);
      touchActive = true;
      await game.waitForAnimationFrames(1);
      await dispatchTouch(session, 'touchStart', [{ ...actionPoint, id: 22 }]);
      await dispatchTouch(session, 'touchEnd', [{ ...actionPoint, id: 22 }]);
      await expect
        .poll(async () => (await readLocalTouchState(page)).abilityCooldownFrames)
        .toBeGreaterThan(0);
      const duringAction = await readLocalTouchState(page);
      expect(duringAction.lastShotTime).toBe(beforeAction.lastShotTime);
      expect(duringAction.abilityCooldownFrames).toBeGreaterThan(0);

      await dispatchTouch(session, 'touchEnd', []);
      touchActive = false;
      await game.waitForAnimationFrames(2);
      const afterAction = await readLocalTouchState(page);
      expect(afterAction.lastShotTime).toBe(beforeAction.lastShotTime);
      expect(afterAction.thrusting).toBe(true);
      expect(diagnostics).toEqual({ errors: [], warnings: [] });
    } finally {
      try {
        if (touchActive) {
          await dispatchTouch(session, 'touchCancel', []);
        }
      } finally {
        await session.detach();
      }
    }
  },
  TestConfig.DEFAULT_TIMEOUT
);

test(
  'a second held canvas touch autofires and releasing it keeps the steering touch thrusting',
  async () => {
    const page = await browserManager.recreatePage({ hasTouch: true });
    if (!page) {
      throw new Error('Page not available');
    }
    await page.setViewportSize({ width: 390, height: 844 });
    const diagnostics = watchBrowserDiagnostics(page);
    const game = new GameInteractions(page);
    await game.bootGame({ waitForCombatReady: false, kitId: 'surveyor' });
    const steer = await centerOf(page, '#gameCanvas');
    const firePoint = await canvasPoint(page, 0.75, 0.5);
    const session = await page.context().newCDPSession(page);
    let touchActive = false;
    try {
      const beforeHold = await readLocalTouchState(page);
      await dispatchTouch(session, 'touchStart', [
        { x: steer.x + 42, y: steer.y, id: 11 },
        { ...firePoint, id: 12 },
      ]);
      touchActive = true;
      await game.waitForAnimationFrames(8);
      const duringHold = await readLocalTouchState(page);
      expect(duringHold.thrusting).toBe(true);
      expect(duringHold.lastShotTime).toBeGreaterThan(beforeHold.lastShotTime);

      await game.waitForAnimationFrames(20);
      const afterAutofire = await readLocalTouchState(page);
      expect(afterAutofire.lastShotTime).toBeGreaterThan(duringHold.lastShotTime);

      await dispatchTouch(session, 'touchEnd', [{ ...firePoint, id: 12 }]);
      // Shots are still allowed while the release command reaches the browser.
      // Start the no-more-shots observation after that input has been delivered.
      const atFireRelease = await readLocalTouchState(page);
      await page.waitForFunction((lastShotTime) => {
        const ship = window.gameController?.getCurrPlayer()?.ship;
        return ship && Date.now() - lastShotTime >= ship.shotCooldown * 2;
      }, atFireRelease.lastShotTime);
      await game.waitForAnimationFrames(2);
      const afterFireRelease = await readLocalTouchState(page);
      expect(afterFireRelease.thrusting).toBe(true);
      expect(afterFireRelease.canShoot).toBe(true);
      expect(afterFireRelease.lastShotTime).toBe(atFireRelease.lastShotTime);

      await dispatchTouch(session, 'touchEnd', []);
      touchActive = false;
      await game.waitForAnimationFrames(2);
      expect((await readLocalTouchState(page)).thrusting).toBe(true);
      expect(diagnostics).toEqual({ errors: [], warnings: [] });
    } finally {
      try {
        if (touchActive) {
          await dispatchTouch(session, 'touchCancel', []);
        }
      } finally {
        await session.detach();
      }
    }
  },
  TestConfig.DEFAULT_TIMEOUT
);

test.each(KITS)(
  'touch E supports movement, firing, cancellation, and the kit action for $kitId',
  async ({ kitId, label, name }) => {
    await browserManager.recreatePage({ hasTouch: true });
    const page = browserManager.getCurrentPage();
    if (!page) {
      throw new Error('Page not available');
    }

    const consoleState = watchBrowserDiagnostics(page);
    await page.setViewportSize({ width: 390, height: 844 });
    const game = new GameInteractions(page);
    await game.bootGame({ waitForCombatReady: false, kitId });
    await arrangeCrewField([await game.getLocalPlayerId()], 'empty');
    await page.waitForFunction(
      () =>
        document.body.classList.contains('touch-play') &&
        !document.querySelector<HTMLElement>('#touch-controls')?.hidden,
      { timeout: 5000 }
    );

    expect(await page.locator('#touch-ability').textContent()).toBe(label);
    expect(await page.locator('#touch-ability').getAttribute('aria-label')).toBe(name);
    expect(await page.locator('#touch-controls button').count()).toBe(2);

    const stick = await centerOf(page, '#gameCanvas');
    const firePoint = await canvasPoint(page, 0.75, 0.5);
    const ability = await centerOf(page, '#touch-ability');
    const session = await page.context().newCDPSession(page);
    const heldTouchPoints: TouchPoint[] = [
      { x: stick.x + 42, y: stick.y - 4, id: 11 },
      { ...firePoint, id: 12 },
    ];

    const beforeMove = await readLocalTouchState(page);
    await dispatchTouch(session, 'touchStart', [
      { x: stick.x + 34, y: stick.y, id: 11 },
      { ...firePoint, id: 12 },
    ]);
    await game.waitForAnimationFrames(8);
    await dispatchTouch(session, 'touchMove', [
      { x: stick.x + 42, y: stick.y - 4, id: 11 },
      { ...firePoint, id: 12 },
    ]);
    await game.waitForAnimationFrames(8);

    const duringTouch = await readLocalTouchState(page);
    expect(duringTouch.thrusting).toBe(true);
    expect(duringTouch.lastShotTime).toBeGreaterThan(beforeMove.lastShotTime);
    expect(await page.locator('#touch-stick').count()).toBe(0);

    // E must remain usable while the two continuous canvas touch sources are held.
    await tapTouchPoint(session, heldTouchPoints, {
      x: ability.x,
      y: ability.y,
      id: 13,
    });
    if (kitId === 'surveyor') {
      await expect
        .poll(async () => (await readLocalTouchState(page)).abilityCooldownFrames)
        .toBeGreaterThan(0);
    }
    await game.waitForAnimationFrames(2);
    const abilityWhileHeld = await readLocalTouchState(page);
    expect(abilityWhileHeld.thrusting).toBe(true);
    if (kitId === 'hauler') {
      // A miss leaves the persistent tow action ready: there is no scan-style
      // cooldown when no cargo was attached.
      expect(abilityWhileHeld.abilityCooldownFrames).toBe(0);
      expect(await page.locator('#touch-ability').getAttribute('aria-disabled')).toBe('false');
    } else {
      expect(abilityWhileHeld.abilityCooldownFrames).toBeGreaterThan(0);
      await tapTouchPoint(session, heldTouchPoints, {
        x: ability.x,
        y: ability.y,
        id: 13,
      });
      await game.waitForAnimationFrames(1);
      const abilityAfterCoolingTap = await readLocalTouchState(page);
      expect(abilityAfterCoolingTap.abilityCooldownFrames).toBeLessThanOrEqual(
        abilityWhileHeld.abilityCooldownFrames
      );
      expect(abilityAfterCoolingTap.abilityCooldownFrames).toBeGreaterThan(0);
      expect(await page.locator('#touch-ability').getAttribute('aria-disabled')).toBe('true');
    }

    // Browser backgrounding releases held firing and steering; automatic thrust stays enabled.
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await game.waitForAnimationFrames(1);
    const afterBlur = await readLocalTouchState(page);
    expect(afterBlur.thrusting).toBe(true);
    expect(afterBlur.canShoot).toBe(true);

    // A real orientation change also drops stale pointer ownership before the
    // controls are laid out for the new viewport.
    await dispatchTouch(session, 'touchStart', [
      { x: stick.x + 34, y: stick.y, id: 21 },
      { ...firePoint, id: 22 },
    ]);
    await game.waitForAnimationFrames(2);
    await page.setViewportSize({ width: 844, height: 390 });
    await page.evaluate(() => window.dispatchEvent(new Event('orientationchange')));
    await game.waitForAnimationFrames(1);
    const afterRotation = await readLocalTouchState(page);
    expect(afterRotation.thrusting).toBe(true);
    expect(afterRotation.canShoot).toBe(true);
    expect(await page.locator('#touch-controls').isHidden()).toBe(false);
    await page.setViewportSize({ width: 390, height: 844 });
    await game.waitForAnimationFrames(1);

    await dispatchTouch(session, 'touchCancel', []);
    await game.waitForAnimationFrames(1);
    const afterCancel = await readLocalTouchState(page);
    expect(afterCancel.thrusting).toBe(true);
    expect(afterCancel.canShoot).toBe(true);
    expect(await page.locator('#touch-stick').count()).toBe(0);

    const mobileScreenshot = screenshotManager.getScreenshotPath(`wave2-touch-${kitId}-mobile.png`);
    await page.screenshot({ path: mobileScreenshot });
    console.log(`📸 ${mobileScreenshot} exists=${existsSync(mobileScreenshot)}`);
    expect(existsSync(mobileScreenshot)).toBe(true);
    expect(consoleState.errors).toEqual([]);
    expect(consoleState.warnings).toEqual([]);
  },
  TestConfig.DEFAULT_TIMEOUT
);

test(
  'a boundary death releases held touch input and disables combat actions',
  async () => {
    await browserManager.recreatePage({ hasTouch: true });
    const page = browserManager.getCurrentPage();
    if (!page) {
      throw new Error('Page not available');
    }
    await page.setViewportSize({ width: 390, height: 844 });
    const game = new GameInteractions(page);
    await game.bootGame();
    const livesBefore = await game.getLives();
    const stick = await centerOf(page, '#gameCanvas');
    const firePoint = await canvasPoint(page, 0.75, 0.5);
    const session = await page.context().newCDPSession(page);
    try {
      await dispatchTouch(session, 'touchStart', [
        { x: stick.x + 34, y: stick.y, id: 31 },
        { ...firePoint, id: 32 },
      ]);
      await game.waitForAnimationFrames(2);
      expect((await readLocalTouchState(page)).thrusting).toBe(true);

      // Capture the transient dead controls before the normal respawn restores them.
      const deadControls = page
        .waitForFunction(
          () => {
            const player = window.gameController?.getCurrPlayer();
            const ability = document.querySelector('#touch-ability');
            if (!player?.ship.exploding || !ability?.classList.contains('is-unavailable')) {
              return false;
            }
            return {
              thrusting: player.ship.thrusting,
              canShoot: player.ship.canShoot,
              abilityDisabled: ability.getAttribute('aria-disabled'),
            };
          },
          undefined,
          { timeout: 15000, polling: 'raf' }
        )
        .then(async (handle) => {
          try {
            return await handle.jsonValue();
          } finally {
            await handle.dispose();
          }
        });
      const [observed] = await Promise.all([deadControls, game.dieOnceViaBoundary()]);
      expect(observed).toEqual({
        thrusting: false,
        canShoot: true,
        abilityDisabled: 'true',
      });
      // Local death disables controls before the server confirms the lost life.
      // dieOnceViaBoundary waits for that confirmation and the respawn placement.
      expect(await game.getLives()).toBe(livesBefore - 1);
      await page.waitForFunction(() => {
        const player = window.gameController?.getCurrPlayer();
        return player && !player.ship.exploding && player.ship.health > 0 && player.ship.thrusting;
      });
      const respawnPosition = await game.getShipPosition();
      await game.waitForAnimationFrames(12);
      const flyingPosition = await game.getShipPosition();
      expect(
        Math.hypot(flyingPosition.x - respawnPosition.x, flyingPosition.y - respawnPosition.y)
      ).toBeGreaterThan(1);
    } finally {
      try {
        await dispatchTouch(session, 'touchCancel', []);
      } finally {
        await session.detach();
      }
    }
  },
  TestConfig.DEFAULT_TIMEOUT
);

test(
  'desktop play view keeps the fixed close camera and hides touch chrome',
  async () => {
    const page = browserManager.getCurrentPage();
    if (!page) {
      throw new Error('Page not available');
    }

    const consoleState = watchBrowserDiagnostics(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    const game = new GameInteractions(page);
    await game.bootGame({ waitForCombatReady: false });
    await game.waitForAnimationFrames(4);

    const beforeMove = await game.getShipPosition();
    await game.waitForAnimationFrames(12);
    const afterMove = await game.getShipPosition();
    expect(Math.hypot(afterMove.x - beforeMove.x, afterMove.y - beforeMove.y)).toBeGreaterThan(5);
    const center = await centerOf(page, '#gameCanvas');
    await page.mouse.move(center.x, center.y - 120);
    await page.waitForFunction(() => {
      const angle = window.gameController?.getCurrPlayer()?.ship.angle;
      return (
        angle !== undefined &&
        Math.abs(Math.atan2(Math.sin(angle - Math.PI / 2), Math.cos(angle - Math.PI / 2))) < 0.001
      );
    });
    await page.keyboard.down('ArrowRight');
    await game.waitForAnimationFrames(8);
    await page.keyboard.up('ArrowRight');
    const keyboardAngle = await game.getShipAngle();
    expect(Math.abs(keyboardAngle - Math.PI / 2)).toBeGreaterThan(0.1);
    await page.mouse.down({ button: 'right' });
    await page.mouse.up({ button: 'right' });
    await page.keyboard.press('KeyW');
    await page.keyboard.press('ArrowUp');
    await game.waitForAnimationFrames(3);
    expect(await game.getShipAngle()).toBeCloseTo(keyboardAngle, 6);
    expect((await readLocalTouchState(page)).thrusting).toBe(true);

    expect(await page.locator('#touch-controls').isHidden()).toBe(true);
    expect(await page.locator('#gameCanvas').isVisible()).toBe(true);
    const desktopScreenshot = screenshotManager.getScreenshotPath('wave2-touch-desktop.png');
    await page.screenshot({ path: desktopScreenshot });
    console.log(`📸 ${desktopScreenshot} exists=${existsSync(desktopScreenshot)}`);
    expect(existsSync(desktopScreenshot)).toBe(true);
    expect(consoleState.errors).toEqual([]);
    expect(consoleState.warnings).toEqual([]);
  },
  TestConfig.DEFAULT_TIMEOUT
);

test(
  'semantic E control activates from keyboard and programmatic clicks',
  async () => {
    await browserManager.recreatePage({ hasTouch: true });
    const page = browserManager.getCurrentPage();
    if (!page) {
      throw new Error('Page not available');
    }

    const consoleState = watchBrowserDiagnostics(page);
    await page.setViewportSize({ width: 390, height: 844 });
    const game = new GameInteractions(page);
    await game.bootGame({ waitForCombatReady: false, kitId: 'surveyor' });
    await page.waitForFunction(
      () =>
        document.body.classList.contains('touch-play') &&
        !document.querySelector<HTMLElement>('#touch-controls')?.hidden,
      { timeout: 5000 }
    );

    const ability = page.locator('#touch-ability');
    await ability.focus();
    await page.keyboard.press('Enter');
    await expect
      .poll(async () => (await readLocalTouchState(page)).abilityCooldownFrames)
      .toBeGreaterThan(0);
    // Wait for the real cooldown. Resetting only the client can make the next
    // snapshot look like a successful second activation even if no click is sent.
    await expect
      .poll(async () => (await readLocalTouchState(page)).abilityCooldownFrames, { timeout: 15000 })
      .toBe(0);
    await ability.evaluate((element) => (element as HTMLButtonElement).click());
    await expect
      .poll(async () => (await readLocalTouchState(page)).abilityCooldownFrames)
      .toBeGreaterThan(0);

    expect(await ability.getAttribute('aria-disabled')).toBe('true');
    expect(consoleState.errors).toEqual([]);
    expect(consoleState.warnings).toEqual([]);
  },
  TestConfig.DEFAULT_TIMEOUT
);
