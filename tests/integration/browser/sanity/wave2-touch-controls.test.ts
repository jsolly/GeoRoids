import { existsSync } from 'node:fs';
import type { CDPSession, Page } from 'playwright';
import { expect, test } from 'vitest';

import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';
import { TestConfig } from '../../utils/test-config';
import {
  canvasPoint,
  centerOf,
  dispatchTouch,
  readTouchControlState as readLocalTouchState,
  type TouchPoint,
} from '../../utils/touch-input';

const { browserManager, screenshotManager } = createBrowserScenarioHooks(__dirname);

const KITS = [
  { kitId: 'dart' as const, label: 'DASH', name: 'Boost dash' },
  { kitId: 'hauler' as const, label: 'HOOK', name: 'Harpoon' },
  { kitId: 'warden' as const, label: 'GUARD', name: 'Projected ally shield' },
  { kitId: 'skirmisher' as const, label: 'RING', name: 'Ring fire' },
  { kitId: 'quake' as const, label: 'PULSE', name: 'Shock pulse' },
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
        await page.waitForFunction(() => window.gameController?.getCurrPlayer()?.ship.thrusting);
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

test(
  'a quick one-finger canvas tap fires on release and then stops thrust',
  async () => {
    const page = await browserManager.recreatePage({ hasTouch: true });
    if (!page) {
      throw new Error('Page not available');
    }
    await page.setViewportSize({ width: 390, height: 844 });
    const diagnostics = collectConsole(page);
    const game = new GameInteractions(page);
    await game.bootGame({ waitForCombatReady: false, kitId: 'dart' });
    const tapPoint = await canvasPoint(page, 0.75, 0.5);
    const session = await page.context().newCDPSession(page);
    let touchActive = false;
    try {
      const beforeTap = await readLocalTouchState(page);
      await dispatchTouch(session, 'touchStart', [{ ...tapPoint, id: 1 }]);
      touchActive = true;
      await game.waitForAnimationFrames(2);
      const duringTap = await readLocalTouchState(page);
      expect(duringTap.thrusting).toBe(false);
      expect(duringTap.lastShotTime).toBe(beforeTap.lastShotTime);

      await dispatchTouch(session, 'touchEnd', []);
      touchActive = false;
      await game.waitForAnimationFrames(2);
      const afterTap = await readLocalTouchState(page);
      expect(afterTap.lastShotTime).toBeGreaterThan(beforeTap.lastShotTime);
      expect(afterTap.thrusting).toBe(false);
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

test.each(['ability', 'shield'] as const)(
  'a %s button tap consumes a pending steering tap without firing',
  async (action) => {
    const page = await browserManager.recreatePage({ hasTouch: true });
    if (!page) {
      throw new Error('Page not available');
    }
    await page.setViewportSize({ width: 390, height: 844 });
    const diagnostics = collectConsole(page);
    const game = new GameInteractions(page);
    await game.bootGame({ waitForCombatReady: false, kitId: 'dart' });
    const steerPoint = await canvasPoint(page, 0.75, 0.5);
    const actionPoint = await centerOf(page, `#touch-${action}`);
    const session = await page.context().newCDPSession(page);
    let touchActive = false;
    try {
      const beforeAction = await readLocalTouchState(page);
      await dispatchTouch(session, 'touchStart', [{ ...steerPoint, id: 21 }]);
      touchActive = true;
      await game.waitForAnimationFrames(1);
      await dispatchTouch(session, 'touchStart', [{ ...actionPoint, id: 22 }]);
      await dispatchTouch(session, 'touchEnd', [{ ...actionPoint, id: 22 }]);
      await game.waitForAnimationFrames(2);
      const duringAction = await readLocalTouchState(page);
      expect(duringAction.lastShotTime).toBe(beforeAction.lastShotTime);
      if (action === 'ability') {
        expect(duringAction.abilityCooldownFrames).toBeGreaterThan(0);
      } else {
        expect(duringAction.shieldActive).toBe(true);
      }

      await dispatchTouch(session, 'touchEnd', []);
      touchActive = false;
      await game.waitForAnimationFrames(2);
      const afterAction = await readLocalTouchState(page);
      expect(afterAction.lastShotTime).toBe(beforeAction.lastShotTime);
      expect(afterAction.thrusting).toBe(false);
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
    const diagnostics = collectConsole(page);
    const game = new GameInteractions(page);
    await game.bootGame({ waitForCombatReady: false, kitId: 'dart' });
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
      await game.waitForAnimationFrames(2);
      const afterFireRelease = await readLocalTouchState(page);
      expect(afterFireRelease.thrusting).toBe(true);
      expect(afterFireRelease.canShoot).toBe(true);
      expect(afterFireRelease.lastShotTime).toBe(afterAutofire.lastShotTime);

      await dispatchTouch(session, 'touchEnd', []);
      touchActive = false;
      await game.waitForAnimationFrames(2);
      expect((await readLocalTouchState(page)).thrusting).toBe(false);
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
    if (kitId === 'warden') {
      await game.placeShipAt(-1700, 0);
      const faction = await page.evaluate(() => window.gameController?.getCurrPlayer()?.factionId);
      let friendlyId: string | undefined;
      for (let index = 0; index < 2; index++) {
        const otherPage = await browserManager.createAdditionalPage();
        const other = new GameInteractions(otherPage);
        await other.bootGame({ kitId: 'dart', waitForCombatReady: false });
        const otherFaction = await otherPage.evaluate(
          () => window.gameController?.getCurrPlayer()?.factionId
        );
        if (otherFaction === faction) {
          friendlyId = await other.getLocalPlayerId();
          await other.placeShipAt(-1580, 80);
        } else {
          await other.placeShipAt(-1900, 500);
        }
      }
      if (!friendlyId) {
        throw new Error('Balanced factions must provide a controlled friendly pilot');
      }
      await page.waitForFunction(
        (id) => {
          const ship = window.gameController
            ?.getNetworkManager()
            .getAllPlayers()
            .find((pilot) => pilot.id === id)?.ship;
          return (
            ship &&
            ship.health > 0 &&
            !ship.exploding &&
            Math.abs(ship.position.x + 1580) < 1 &&
            Math.abs(ship.position.y - 80) < 1
          );
        },
        friendlyId,
        { timeout: 5000 }
      );
    }
    await page.waitForFunction(
      () =>
        document.body.classList.contains('touch-play') &&
        !document.getElementById('touch-controls')?.hidden,
      { timeout: 5000 }
    );

    expect(await page.locator('#touch-ability').textContent()).toBe(label);
    expect(await page.locator('#touch-ability').getAttribute('aria-label')).toBe(name);
    expect(await page.locator('#touch-shield').getAttribute('aria-label')).toBe('Shield bubble');
    expect(await page.locator('#touch-controls button').count()).toBe(2);

    const stick = await centerOf(page, '#gameCanvas');
    const firePoint = await canvasPoint(page, 0.75, 0.5);
    const ability = await centerOf(page, '#touch-ability');
    const shield = await centerOf(page, '#touch-shield');
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

    // E and F must remain usable while the two continuous canvas touch sources are
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
      // E protects the friendly recipient; it does not restore the caster's F shield.
      expect(shieldDownWhileHeld.shieldTimer).toBe(0);
    }
    expect(await page.locator('#touch-shield').getAttribute('aria-disabled')).toBe('true');

    // Browser backgrounding must release every continuous source.
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await game.waitForAnimationFrames(1);
    const afterBlur = await readLocalTouchState(page);
    expect(afterBlur.thrusting).toBe(false);
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
    expect(afterRotation.thrusting).toBe(false);
    expect(afterRotation.canShoot).toBe(true);
    expect(await page.locator('#touch-controls').isHidden()).toBe(false);
    await page.setViewportSize({ width: 390, height: 844 });
    await game.waitForAnimationFrames(1);

    await dispatchTouch(session, 'touchCancel', []);
    await game.waitForAnimationFrames(1);
    const afterCancel = await readLocalTouchState(page);
    expect(afterCancel.thrusting).toBe(false);
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
