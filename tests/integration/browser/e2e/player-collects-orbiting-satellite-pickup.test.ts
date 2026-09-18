import assert from 'node:assert/strict';
import { expect, test } from 'vitest';
import { SATELLITE_PICKUP } from '../../../../src/constants';
import { installAudioProbe } from '../../utils/audio-probe';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';
import { TestConfig } from '../../utils/test-config';
import { centerOf, dispatchTouch } from '../../utils/touch-input';

const { browserManager, screenshotManager } = createBrowserScenarioHooks(__dirname);

test.each([
  { width: 1280, kitId: 'hauler' },
  { width: 390, kitId: 'surveyor' },
  { width: 390, kitId: 'hauler' },
] as const)(
  'a $kitId stores a satellite and equips it from the schematic at $width pixels',
  async ({ width, kitId }) => {
    const page =
      width === 390
        ? await browserManager.recreatePage({ hasTouch: true })
        : browserManager.getCurrentPage();
    if (!page) {
      throw new Error('Page not available');
    }

    const capture = width === 390 && kitId === 'hauler' ? '390-hauler' : String(width);
    await page.setViewportSize({ width, height: 900 });
    const errors: string[] = [];
    const warnings: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') {
        errors.push(message.text());
      }
      if (message.type() === 'warning') {
        warnings.push(message.text());
      }
    });
    await installAudioProbe(page);
    const sent: string[] = [];
    page.on('websocket', (socket) =>
      socket.on('framesent', ({ payload }) => {
        sent.push(JSON.parse(String(payload)).type);
      })
    );
    const game = new GameInteractions(page);
    // Start before automatic thrust can carry the pilot into a pickup.
    await game.bootGame({ kitId, waitForCombatReady: false });
    await game.placeShipAt(0, 0);
    await page.keyboard.press('v');
    await expect
      .poll(() => page.locator('#ship-schematic-inventory').textContent())
      .toContain('No satellites stored');
    await page.keyboard.press('Escape');
    await game.waitForSatellitePickups(2);

    const pickups = await game.getSatellitePickups();
    expect(pickups.length).toBeGreaterThanOrEqual(2);

    const target = pickups.find((pickup) => pickup.state === 'loose');
    assert.ok(target, 'Loose satellite pickup missing');
    await game.waitForAnimationFrames(20);
    expect((await game.getSatellitePickups()).find((pickup) => pickup.id === target.id)).toEqual(
      target
    );
    await page.screenshot({
      path: screenshotManager.getScreenshotPath(`satellite-loose-${capture}.png`),
    });
    const scoreBefore = await game.getScore();
    const pickupSound = await page.evaluate(async () => {
      const context = new OfflineAudioContext(1, 1, 48000);
      const response = await fetch('/sounds/orbital-pickup.m4a');
      if (!response.ok) {
        throw new Error('Satellite pickup sound missing');
      }
      const buffer = await context.decodeAudioData(await response.arrayBuffer());
      return {
        duration: buffer.duration,
        eventCount: JSON.parse(document.documentElement.dataset['audioEvents'] ?? '[]').length,
      };
    });

    await game.placeShipAt(target.x + 110, target.y);
    await expect
      .poll(
        async () => {
          const later = await game.getSatellitePickups();
          return later.find((pickup) => pickup.id === target.id)?.state ?? '';
        },
        {
          timeout: 10000,
          message: 'the collected satellite should enter inventory',
        }
      )
      .toBe('stored');
    expect(
      await page.evaluate(() => window.gameController?.getGameStateManager().getPickupMessage())
    ).toBe(`${target.name} acquired`);

    if (width === 390) {
      const session = await page.context().newCDPSession(page);
      const center = await centerOf(page, '#gameCanvas');
      try {
        await dispatchTouch(session, 'touchStart', [{ ...center, id: 1 }]);
        await page.waitForFunction(() =>
          document.querySelector('dialog#ship-schematic-dialog')?.hasAttribute('open')
        );
      } finally {
        await dispatchTouch(session, 'touchEnd', []);
        await session.detach();
      }
    } else {
      await page.keyboard.press('v');
    }
    const inventory = page.locator('#ship-schematic-inventory');
    await expect.poll(() => inventory.textContent()).toContain(target.name);
    await page.screenshot({
      path: screenshotManager.getScreenshotPath(`satellite-inventory-stored-${capture}.png`),
    });
    const equipButton = page.getByRole('button', { name: `Equip ${target.name}`, exact: true });
    await equipButton.focus();
    await page.keyboard.press('Enter');
    await expect
      .poll(
        async () =>
          (await game.getSatellitePickups()).find((pickup) => pickup.id === target.id)?.state
      )
      .toBe('orbiting');
    await expect.poll(() => inventory.textContent()).toContain('Equipped');
    await expect.poll(() => inventory.textContent()).toContain('remaining');
    await expect
      .poll(() => page.locator('#satellite-inventory-status').textContent())
      .toBe(`${target.name} equipped.`);
    expect(
      await page
        .locator('#ship-schematic-return')
        .evaluate((button) => button === document.activeElement)
    ).toBe(true);
    const healthBefore = (await game.getSatellitePickups()).find(
      (pickup) => pickup.id === target.id
    )?.health;
    assert.ok(healthBefore);
    await game.waitForAnimationFrames(90);
    const draining = (await game.getSatellitePickups()).find((pickup) => pickup.id === target.id);
    assert.ok(draining);
    expect(draining.health).toBeLessThan(healthBefore);
    expect(draining.health).toBeGreaterThan(healthBefore - 2);
    expect(await page.locator('#satellite-inventory-status').textContent()).toBe(
      `${target.name} equipped.`
    );
    expect(
      await page
        .locator('#ship-schematic-return')
        .evaluate((button) => button === document.activeElement)
    ).toBe(true);

    await page.screenshot({
      path: screenshotManager.getScreenshotPath(`satellite-inventory-equipped-${capture}.png`),
    });
    await page.getByRole('button', { name: 'Return to flight', exact: true }).click();

    await expect
      .poll(async () => game.getScore(), {
        timeout: 8000,
        message: 'collecting a satellite pickup should award points',
      })
      .toBeGreaterThanOrEqual(scoreBefore + SATELLITE_PICKUP.SCORE_BONUS);
    const attached = (await game.getSatellitePickups()).find((pickup) => pickup.id === target.id);
    assert.ok(attached);
    expect(attached.health).toBeGreaterThan(0);
    expect(attached.health).toBeLessThan(attached.maxHealth);
    expect(sent).not.toContain('satellitePickupCollected');
    expect(sent).toContain('equipSatellite');
    await expect
      .poll(() =>
        page.evaluate(({ duration, eventCount }) => {
          const events: Array<{ duration: number }> = JSON.parse(
            document.documentElement.dataset['audioEvents'] ?? '[]'
          );
          return events
            .slice(eventCount)
            .some((event) => Math.abs(event.duration - duration) < 0.002);
        }, pickupSound)
      )
      .toBe(true);
    await page.screenshot({
      path: screenshotManager.getScreenshotPath(`satellite-orbit-${capture}.png`),
    });
    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
  },
  TestConfig.DEFAULT_TIMEOUT
);
