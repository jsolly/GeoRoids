import { existsSync } from 'node:fs';
import type { CDPSession, Page } from 'playwright';
import { expect, test } from 'vitest';

import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';
import { TestConfig } from '../../utils/test-config';
import {
  centerOf,
  dispatchTouch,
  readTouchControlState as readLocalTouchState,
  type TouchPoint,
} from '../../utils/touch-input';

const { browserManager, screenshotManager } = createBrowserScenarioHooks(__dirname);

const KITS = [
  { kitId: 'dart' as const, label: 'DASH', name: 'Boost dash' },
  { kitId: 'hauler' as const, label: 'HOOK', name: 'Harpoon' },
  { kitId: 'warden' as const, label: 'ABSORB', name: 'Timed absorb shield' },
  { kitId: 'skirmisher' as const, label: 'BURST', name: 'Burst fire' },
  { kitId: 'quake' as const, label: 'PULSE', name: 'Shock pulse' },
];

async function tapTouchPoint(
  session: CDPSession,
  heldPoints: TouchPoint[],
  touchPoint: TouchPoint
): Promise<void> {
  // Preserve the active stick/fire contacts while Chromium delivers the
  // changed third contact. This keeps the continuous controls under test.
  await dispatchTouch(session, 'touchMove', heldPoints);
  await dispatchTouch(session, 'touchStart', [touchPoint]);
  await dispatchTouch(session, 'touchEnd', [touchPoint]);
  await dispatchTouch(session, 'touchMove', heldPoints);
}

function collectConsole(page: Page): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') {
      errors.push(message.text());
    } else if (message.type() === 'warning') {
      warnings.push(message.text());
    }
  });
  page.on('pageerror', (error) => errors.push(error.message));
  return { errors, warnings };
}

test(
  'touching the playfield steers toward the finger and release stops thrust',
  async () => {
    const page = await browserManager.recreatePage({ hasTouch: true });
    if (!page) {
      throw new Error('Page not available');
    }
    await page.setViewportSize({ width: 390, height: 844 });
    const diagnostics = collectConsole(page);
    const game = new GameInteractions(page);
    await game.bootGame({ waitForCombatReady: false, kitId: 'hauler' });
    const center = await centerOf(page, '#gameCanvas');
    const session = await page.context().newCDPSession(page);
    let touchActive = false;
    try {
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
        await game.waitForAnimationFrames(2);
        expect((await readLocalTouchState(page)).thrusting).toBe(true);
        const angle = await page.evaluate(() => window.gameController?.getCurrPlayer()?.ship.angle);
        expect(angle).toBeCloseTo(point.angle, 3);
      }
      await dispatchTouch(session, 'touchEnd', []);
      touchActive = false;
      await game.waitForAnimationFrames(2);
      expect((await readLocalTouchState(page)).thrusting).toBe(false);
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

test.each(KITS)(
  'touch E and F support movement, firing, cancellation, and cooldown for $kitId',
  async ({ kitId, label, name }) => {
    await browserManager.recreatePage({ hasTouch: true });
    const page = browserManager.getCurrentPage();
    if (!page) {
      throw new Error('Page not available');
    }

    const consoleState = collectConsole(page);
    await page.setViewportSize({ width: 390, height: 844 });
    const game = new GameInteractions(page);
    await game.bootGame({ waitForCombatReady: false, kitId });
    await page.waitForFunction(
      () =>
        document.body.classList.contains('touch-play') &&
        !document.getElementById('touch-controls')?.hidden,
      { timeout: 5000 }
    );

    expect(await page.locator('#touch-ability').textContent()).toBe(label);
    expect(await page.locator('#touch-ability').getAttribute('aria-label')).toBe(name);
    expect(await page.locator('#touch-shield').getAttribute('aria-label')).toBe('Shield bubble');

    const stick = await centerOf(page, '#gameCanvas');
    const fire = await centerOf(page, '#touch-fire');
    const ability = await centerOf(page, '#touch-ability');
    const shield = await centerOf(page, '#touch-shield');
    const session = await page.context().newCDPSession(page);
    const heldTouchPoints: TouchPoint[] = [
      { x: stick.x + 42, y: stick.y - 4, id: 11 },
      { x: fire.x, y: fire.y, id: 12 },
    ];

    const beforeMove = await readLocalTouchState(page);
    await dispatchTouch(session, 'touchStart', [
      { x: stick.x + 34, y: stick.y, id: 11 },
      { x: fire.x, y: fire.y, id: 12 },
    ]);
    await game.waitForAnimationFrames(8);
    await dispatchTouch(session, 'touchMove', [
      { x: stick.x + 42, y: stick.y - 4, id: 11 },
      { x: fire.x, y: fire.y, id: 12 },
    ]);
    await game.waitForAnimationFrames(8);

    const duringTouch = await readLocalTouchState(page);
    expect(duringTouch.thrusting).toBe(true);
    expect(duringTouch.lastShotTime).toBeGreaterThan(beforeMove.lastShotTime);
    expect(
      await page.locator('#touch-fire').evaluate((el) => el.classList.contains('is-pressed'))
    ).toBe(true);
    expect(await page.locator('#touch-stick').count()).toBe(0);

    // E and F must remain usable while the two continuous touch sources are
    // held. The E action is kit-specific; the F bubble is shared.
    await tapTouchPoint(session, heldTouchPoints, {
      x: ability.x,
      y: ability.y,
      id: 13,
    });
    await game.waitForAnimationFrames(2);
    const abilityWhileHeld = await readLocalTouchState(page);
    expect(abilityWhileHeld.abilityCooldownFrames).toBeGreaterThan(0);
    expect(abilityWhileHeld.thrusting).toBe(true);
    expect(
      await page.locator('#touch-fire').evaluate((el) => el.classList.contains('is-pressed'))
    ).toBe(true);
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

    await tapTouchPoint(session, heldTouchPoints, {
      x: shield.x,
      y: shield.y,
      id: 14,
    });
    await game.waitForAnimationFrames(2);
    const shieldWhileHeld = await readLocalTouchState(page);
    expect(shieldWhileHeld.shieldActive).toBe(true);
    expect(shieldWhileHeld.thrusting).toBe(true);
    expect(
      await page.locator('#touch-shield').evaluate((el) => el.classList.contains('is-active'))
    ).toBe(true);

    await tapTouchPoint(session, heldTouchPoints, {
      x: shield.x,
      y: shield.y,
      id: 14,
    });
    await game.waitForAnimationFrames(1);
    const shieldDownWhileHeld = await readLocalTouchState(page);
    expect(shieldDownWhileHeld.shieldActive).toBe(false);
    expect(shieldDownWhileHeld.shieldCooldown).toBeGreaterThan(0);
    if (kitId === 'warden') {
      // Warden E's absorb timer is independent from the F bubble toggle.
      expect(shieldDownWhileHeld.shieldTimer).toBeGreaterThan(0);
    }
    expect(await page.locator('#touch-shield').getAttribute('aria-disabled')).toBe('true');

    // Browser backgrounding must release every continuous source.
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await game.waitForAnimationFrames(1);
    const afterBlur = await readLocalTouchState(page);
    expect(afterBlur.thrusting).toBe(false);
    expect(afterBlur.canShoot).toBe(true);
    expect(
      await page.locator('#touch-fire').evaluate((el) => el.classList.contains('is-pressed'))
    ).toBe(false);

    // A real orientation change also drops stale pointer ownership before the
    // controls are laid out for the new viewport.
    await dispatchTouch(session, 'touchStart', [
      { x: stick.x + 34, y: stick.y, id: 21 },
      { x: fire.x, y: fire.y, id: 22 },
    ]);
    await game.waitForAnimationFrames(2);
    await page.setViewportSize({ width: 844, height: 390 });
    await page.evaluate(() => window.dispatchEvent(new Event('orientationchange')));
    await game.waitForAnimationFrames(1);
    const afterRotation = await readLocalTouchState(page);
    expect(afterRotation.thrusting).toBe(false);
    expect(afterRotation.canShoot).toBe(true);
    expect(
      await page.locator('#touch-fire').evaluate((el) => el.classList.contains('is-pressed'))
    ).toBe(false);
    expect(await page.locator('#touch-controls').isHidden()).toBe(false);
    await page.setViewportSize({ width: 390, height: 844 });
    await game.waitForAnimationFrames(1);

    await dispatchTouch(session, 'touchCancel', []);
    await game.waitForAnimationFrames(1);
    const afterCancel = await readLocalTouchState(page);
    expect(afterCancel.thrusting).toBe(false);
    expect(afterCancel.canShoot).toBe(true);
    expect(
      await page.locator('#touch-fire').evaluate((el) => el.classList.contains('is-pressed'))
    ).toBe(false);
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
    const fire = await centerOf(page, '#touch-fire');
    const session = await page.context().newCDPSession(page);
    try {
      await dispatchTouch(session, 'touchStart', [
        { x: stick.x + 34, y: stick.y, id: 31 },
        { x: fire.x, y: fire.y, id: 32 },
      ]);
      await game.waitForAnimationFrames(2);
      expect((await readLocalTouchState(page)).thrusting).toBe(true);
      expect(
        await page.locator('#touch-fire').evaluate((el) => el.classList.contains('is-pressed'))
      ).toBe(true);

      // Capture the transient dead controls before the normal respawn restores them.
      const deadControls = page
        .waitForFunction(
          () => {
            const player = window.gameController?.getCurrPlayer();
            const ability = document.getElementById('touch-ability');
            const shield = document.getElementById('touch-shield');
            if (
              !player?.ship.exploding ||
              !ability?.classList.contains('is-unavailable') ||
              !shield?.classList.contains('is-unavailable')
            ) {
              return false;
            }
            return {
              lives: player.lives,
              thrusting: player.ship.thrusting,
              canShoot: player.ship.canShoot,
              firePressed: document.getElementById('touch-fire')?.classList.contains('is-pressed'),
              abilityDisabled: ability.getAttribute('aria-disabled'),
              shieldDisabled: shield.getAttribute('aria-disabled'),
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
        lives: livesBefore - 1,
        thrusting: false,
        canShoot: true,
        firePressed: false,
        abilityDisabled: 'true',
        shieldDisabled: 'true',
      });
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

    const consoleState = collectConsole(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    const game = new GameInteractions(page);
    await game.bootGame({ waitForCombatReady: false });
    await game.waitForAnimationFrames(4);

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
  'semantic E and F controls activate from keyboard and programmatic clicks',
  async () => {
    await browserManager.recreatePage({ hasTouch: true });
    const page = browserManager.getCurrentPage();
    if (!page) {
      throw new Error('Page not available');
    }

    const consoleState = collectConsole(page);
    await page.setViewportSize({ width: 390, height: 844 });
    const game = new GameInteractions(page);
    await game.bootGame({ waitForCombatReady: false, kitId: 'dart' });
    await page.waitForFunction(
      () =>
        document.body.classList.contains('touch-play') &&
        !document.getElementById('touch-controls')?.hidden,
      { timeout: 5000 }
    );

    const ability = page.locator('#touch-ability');
    const shield = page.locator('#touch-shield');
    await ability.focus();
    await page.keyboard.press('Enter');
    await game.waitForAnimationFrames(2);
    expect((await readLocalTouchState(page)).abilityCooldownFrames).toBeGreaterThan(0);

    await page.evaluate(() => {
      const ship = window.gameController?.getCurrPlayer()?.ship;
      if (!ship) {
        throw new Error('Local ship unavailable');
      }
      ship.abilityCooldownFrames = 0;
      ship.abilityActiveFrames = 0;
    });
    await ability.evaluate((element) => (element as HTMLButtonElement).click());
    await game.waitForAnimationFrames(2);
    expect((await readLocalTouchState(page)).abilityCooldownFrames).toBeGreaterThan(0);

    await shield.focus();
    await page.keyboard.press('Space');
    await game.waitForAnimationFrames(2);
    expect((await readLocalTouchState(page)).shieldActive).toBe(true);
    await shield.evaluate((element) => (element as HTMLButtonElement).click());
    await game.waitForAnimationFrames(1);
    const afterProgrammaticShield = await readLocalTouchState(page);
    expect(afterProgrammaticShield.shieldActive).toBe(false);
    expect(afterProgrammaticShield.shieldCooldown).toBeGreaterThan(0);

    expect(await ability.getAttribute('aria-disabled')).toBe('true');
    expect(await shield.getAttribute('aria-disabled')).toBe('true');
    expect(consoleState.errors).toEqual([]);
    expect(consoleState.warnings).toEqual([]);
  },
  TestConfig.DEFAULT_TIMEOUT
);
