import { existsSync } from 'node:fs';
import type { CDPSession, Page } from 'playwright';
import { expect, test } from 'vitest';

import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';
import { TestConfig } from '../../utils/test-config';

const { browserManager, screenshotManager } = createBrowserScenarioHooks();

const KITS = [
  { kitId: 'dart' as const, label: 'DASH', name: 'Boost dash' },
  { kitId: 'hauler' as const, label: 'HOOK', name: 'Harpoon' },
  { kitId: 'warden' as const, label: 'ABSORB', name: 'Timed absorb shield' },
  { kitId: 'skirmisher' as const, label: 'BURST', name: 'Burst fire' },
  { kitId: 'quake' as const, label: 'PULSE', name: 'Shock pulse' },
];

type TouchPoint = { x: number; y: number; id: number };
const TOUCH_IDS = {
  stick: 11,
  fire: 12,
  ability: 13,
  shield: 14,
  rotationStick: 21,
  rotationFire: 22,
} as const;

async function centerOf(page: Page, selector: string): Promise<{ x: number; y: number }> {
  const box = await page.locator(selector).boundingBox();
  if (!box) {
    throw new Error(`Missing touch target ${selector}`);
  }
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function dispatchTouch(
  session: CDPSession,
  type: 'touchStart' | 'touchMove' | 'touchCancel' | 'touchEnd',
  touchPoints: TouchPoint[]
): Promise<void> {
  await session.send('Input.dispatchTouchEvent', {
    type,
    touchPoints,
    modifiers: 0,
  });
}

async function tapTouchPoint(
  session: CDPSession,
  heldPoints: TouchPoint[],
  touchPoint: TouchPoint
): Promise<void> {
  // Keep the two continuous contacts in the sequence before and after the
  // third finger. Chromium expands the changed point with those active
  // contacts when it creates the browser touch event.
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

async function readLocalTouchState(page: Page): Promise<{
  position: { x: number; y: number };
  thrusting: boolean;
  canShoot: boolean;
  lastShotTime: number;
  lasers: number;
  abilityCooldownFrames: number;
  abilityActiveFrames: number;
  shieldActive: boolean;
  shieldTimer: number;
  shieldCooldown: number;
  shieldFlashTime: number;
}> {
  return page.evaluate(() => {
    const gc = window.gameController;
    const ship = gc?.getPlayerManager().getLocalPlayer()?.ship;
    if (!ship) {
      throw new Error('Local ship unavailable');
    }
    return {
      position: { x: ship.position.x, y: ship.position.y },
      thrusting: ship.thrusting,
      canShoot: ship.canShoot,
      lastShotTime: ship.lastShotTime,
      lasers: ship.lasers.length,
      abilityCooldownFrames: ship.abilityCooldownFrames,
      abilityActiveFrames: ship.abilityActiveFrames,
      shieldActive: ship.shieldActive,
      shieldTimer: ship.shieldTimer,
      shieldCooldown: ship.shieldCooldown,
      shieldFlashTime: ship.shieldFlashTime,
    };
  });
}

test.each(KITS)(
  'touch E and F support movement, firing, cancellation, cooldown, and local death reset for $kitId',
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
      undefined,
      { timeout: 5000 }
    );

    expect(await page.locator('#touch-ability').textContent()).toBe(label);
    expect(await page.locator('#touch-ability').getAttribute('aria-label')).toBe(name);
    expect(await page.locator('#touch-shield').getAttribute('aria-label')).toBe('Shield bubble');

    const stick = await centerOf(page, '#touch-stick');
    const fire = await centerOf(page, '#touch-fire');
    const ability = await centerOf(page, '#touch-ability');
    const shield = await centerOf(page, '#touch-shield');
    const session = await page.context().newCDPSession(page);

    const beforeMove = await readLocalTouchState(page);
    const heldTouchPoints: TouchPoint[] = [
      { x: stick.x + 42, y: stick.y - 4, id: TOUCH_IDS.stick },
      { x: fire.x, y: fire.y, id: TOUCH_IDS.fire },
    ];
    await dispatchTouch(session, 'touchStart', [
      { x: stick.x + 34, y: stick.y, id: TOUCH_IDS.stick },
      { x: fire.x, y: fire.y, id: TOUCH_IDS.fire },
    ]);
    await game.runGameFrames(8);
    await dispatchTouch(session, 'touchMove', heldTouchPoints);
    await game.runGameFrames(8);

    const duringTouch = await readLocalTouchState(page);
    expect(duringTouch.thrusting).toBe(true);
    expect(duringTouch.lastShotTime).toBeGreaterThan(beforeMove.lastShotTime);
    expect(
      await page.locator('#touch-fire').evaluate((el) => el.classList.contains('is-pressed'))
    ).toBe(true);
    expect(await page.locator('#touch-stick-knob').getAttribute('style')).toContain('translate');

    // E and F must remain usable while the two continuous touch sources are
    // held. The E action is kit-specific; the F bubble is shared.
    await tapTouchPoint(session, heldTouchPoints, {
      x: ability.x,
      y: ability.y,
      id: TOUCH_IDS.ability,
    });
    await game.runGameFrames(2);
    const abilityWhileHeld = await readLocalTouchState(page);
    expect(abilityWhileHeld.abilityCooldownFrames).toBeGreaterThan(0);
    expect(abilityWhileHeld.thrusting).toBe(true);
    expect(
      await page.locator('#touch-fire').evaluate((el) => el.classList.contains('is-pressed'))
    ).toBe(true);
    await tapTouchPoint(session, heldTouchPoints, {
      x: ability.x,
      y: ability.y,
      id: TOUCH_IDS.ability,
    });
    await game.runGameFrames(1);
    const abilityAfterCoolingTap = await readLocalTouchState(page);
    expect(abilityAfterCoolingTap.abilityCooldownFrames).toBeLessThanOrEqual(
      abilityWhileHeld.abilityCooldownFrames
    );
    expect(abilityAfterCoolingTap.abilityCooldownFrames).toBeGreaterThan(0);
    expect(await page.locator('#touch-ability').getAttribute('aria-disabled')).toBe('true');

    await tapTouchPoint(session, heldTouchPoints, {
      x: shield.x,
      y: shield.y,
      id: TOUCH_IDS.shield,
    });
    await game.runGameFrames(2);
    const shieldWhileHeld = await readLocalTouchState(page);
    expect(shieldWhileHeld.shieldActive).toBe(true);
    expect(shieldWhileHeld.thrusting).toBe(true);
    expect(
      await page.locator('#touch-shield').evaluate((el) => el.classList.contains('is-active'))
    ).toBe(true);

    await tapTouchPoint(session, heldTouchPoints, {
      x: shield.x,
      y: shield.y,
      id: TOUCH_IDS.shield,
    });
    await game.runGameFrames(1);
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
    await game.runGameFrames(1);
    const afterBlur = await readLocalTouchState(page);
    expect(afterBlur.thrusting).toBe(false);
    expect(afterBlur.canShoot).toBe(true);
    expect(
      await page.locator('#touch-fire').evaluate((el) => el.classList.contains('is-pressed'))
    ).toBe(false);
    await dispatchTouch(session, 'touchCancel', []);

    // A real orientation change also drops stale pointer ownership before the
    // controls are laid out for the new viewport.
    await dispatchTouch(session, 'touchStart', [
      { x: stick.x + 34, y: stick.y, id: TOUCH_IDS.rotationStick },
      { x: fire.x, y: fire.y, id: TOUCH_IDS.rotationFire },
    ]);
    await game.runGameFrames(2);
    await page.setViewportSize({ width: 844, height: 390 });
    await page.evaluate(() => window.dispatchEvent(new Event('orientationchange')));
    await game.runGameFrames(1);
    const afterRotation = await readLocalTouchState(page);
    expect(afterRotation.thrusting).toBe(false);
    expect(afterRotation.canShoot).toBe(true);
    expect(
      await page.locator('#touch-fire').evaluate((el) => el.classList.contains('is-pressed'))
    ).toBe(false);
    expect(await page.locator('#touch-controls').isHidden()).toBe(false);
    await page.setViewportSize({ width: 390, height: 844 });
    await game.runGameFrames(1);

    await dispatchTouch(session, 'touchCancel', []);
    await game.runGameFrames(1);
    const afterCancel = await readLocalTouchState(page);
    expect(afterCancel.thrusting).toBe(false);
    expect(afterCancel.canShoot).toBe(true);
    expect(
      await page.locator('#touch-fire').evaluate((el) => el.classList.contains('is-pressed'))
    ).toBe(false);
    expect(await page.locator('#touch-stick-knob').getAttribute('style')).toBe(
      'transform: translate(-50%, -50%);'
    );

    // Drive the real lifecycle path while both touch sources are held. The
    // next game tick must release every source and mark both actions dead.
    await dispatchTouch(session, 'touchStart', heldTouchPoints);
    await game.runGameFrames(2);
    expect((await readLocalTouchState(page)).thrusting).toBe(true);
    expect(
      await page.locator('#touch-fire').evaluate((el) => el.classList.contains('is-pressed'))
    ).toBe(true);
    const afterDeath = await page.evaluate(() => {
      const gc = window.gameController;
      const player = gc?.getPlayerManager().getLocalPlayer();
      const ability = document.getElementById('touch-ability');
      const shield = document.getElementById('touch-shield');
      if (!gc || !player || !ability || !shield) {
        throw new Error('Game controller, local player, or touch action unavailable');
      }
      player.ship.health = 0;
      player.ship.exploding = true;
      gc.updateGame();
      return {
        thrusting: player.ship.thrusting,
        canShoot: player.ship.canShoot,
        abilityDisabled: ability.getAttribute('aria-disabled'),
        shieldDisabled: shield.getAttribute('aria-disabled'),
        abilityUnavailable: ability.classList.contains('is-unavailable'),
        shieldUnavailable: shield.classList.contains('is-unavailable'),
      };
    });
    expect(afterDeath.thrusting).toBe(false);
    expect(afterDeath.canShoot).toBe(true);
    expect(afterDeath.abilityDisabled).toBe('true');
    expect(afterDeath.shieldDisabled).toBe('true');
    expect(afterDeath.abilityUnavailable).toBe(true);
    expect(afterDeath.shieldUnavailable).toBe(true);

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
    await game.runGameFrames(4);

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
      undefined,
      { timeout: 5000 }
    );

    const ability = page.locator('#touch-ability');
    const shield = page.locator('#touch-shield');
    await ability.focus();
    await page.keyboard.press('Enter');
    await game.runGameFrames(2);
    expect((await readLocalTouchState(page)).abilityCooldownFrames).toBeGreaterThan(0);

    await page.evaluate(() => {
      const ship = window.gameController?.getPlayerManager().getLocalPlayer()?.ship;
      if (!ship) {
        throw new Error('Local ship unavailable');
      }
      ship.abilityCooldownFrames = 0;
      ship.abilityActiveFrames = 0;
    });
    await ability.evaluate((element) => (element as HTMLButtonElement).click());
    await game.runGameFrames(2);
    expect((await readLocalTouchState(page)).abilityCooldownFrames).toBeGreaterThan(0);

    await shield.focus();
    await page.keyboard.press('Space');
    await game.runGameFrames(2);
    expect((await readLocalTouchState(page)).shieldActive).toBe(true);
    await shield.evaluate((element) => (element as HTMLButtonElement).click());
    await game.runGameFrames(1);
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
