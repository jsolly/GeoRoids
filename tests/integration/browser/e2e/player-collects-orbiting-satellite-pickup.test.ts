import assert from 'node:assert/strict';
import { expect, test } from 'vitest';
import { SATELLITE_PICKUP } from '../../../../src/constants';
import { installAudioProbe, readSamplePlaybackRates } from '../../utils/audio-probe';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';
import { TestConfig } from '../../utils/test-config';
import { arrangeCrewField } from '../../utils/test-server-control';

const { browserManager, screenshotManager } = createBrowserScenarioHooks(__dirname);

test.each([
  { width: 1280, kitId: 'hauler' },
  { width: 390, kitId: 'scout' },
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
    await arrangeCrewField([await game.getLocalPlayerId()], 'satellite');
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

    // Establish the destination sector before collection so its entry banner
    // cannot overwrite the acquisition notice in the same snapshot.
    await game.placeShipAt(target.x + 250, target.y);
    await game.waitForAnimationFrames(10);
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
    const equipHint = await page.evaluate(() => {
      const canvasElement = document.querySelector('#gameCanvas');
      const controller = window.gameController;
      if (!canvasElement || !controller) {
        return [];
      }
      const original = CanvasRenderingContext2D.prototype.fillText;
      const texts: string[] = [];
      CanvasRenderingContext2D.prototype.fillText = function (
        this: CanvasRenderingContext2D,
        text: string,
        x: number,
        y: number,
        maxWidth?: number
      ): void {
        if (this.canvas === canvasElement) {
          texts.push(text);
        }
        original.call(this, text, x, y, maxWidth);
      };
      try {
        controller.renderGame();
      } finally {
        CanvasRenderingContext2D.prototype.fillText = original;
      }
      return texts;
    });
    expect(equipHint).toContain('Equipment is in your inventory');
    expect(equipHint).not.toContain('Tap and hold your ship');
    if (width === 390) {
      expect(equipHint).toContain('Tap Inventory to equip');
      expect(equipHint).not.toContain('Press V');
    } else {
      expect(equipHint).toContain('Press V to equip');
      expect(equipHint).not.toContain('Tap Inventory');
    }
    await page.screenshot({
      path: screenshotManager.getScreenshotPath(`satellite-equip-hint-${capture}.png`),
    });

    if (width === 390) {
      await page.locator('#ship-schematic-toggle').tap();
    } else {
      await page.keyboard.press('v');
    }
    await page.locator('#ship-schematic-dialog').waitFor({ state: 'visible' });
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
    const orbitAudio = await page.evaluate(() => ({
      active: Number(document.documentElement.dataset['activeTones']),
      motion: JSON.parse(document.documentElement.dataset['orbitMotion'] ?? '[]') as Array<{
        kind: string;
        value: number;
      }>,
    }));
    expect(orbitAudio.active).toBe(2);
    const pans = orbitAudio.motion
      .filter((motion) => motion.kind === 'pan')
      .map((motion) => motion.value);
    const detunes = orbitAudio.motion
      .filter((motion) => motion.kind === 'detune')
      .map((motion) => motion.value);
    expect(Math.max(...pans) - Math.min(...pans)).toBeGreaterThan(0.2);
    expect(Math.max(...detunes) - Math.min(...detunes)).toBeGreaterThan(5);
    expect(Math.max(...detunes.map(Math.abs))).toBeLessThanOrEqual(18);
    // Observe the real AudioParam: the orbit becomes audible, then fully silent.
    const orbitGain = () =>
      page.evaluate(() => {
        const gains: number[] = JSON.parse(document.documentElement.dataset['orbitGains'] ?? '[]');
        return Math.min(...gains);
      });
    await expect.poll(orbitGain, { timeout: 5000, interval: 50 }).toBeGreaterThan(0.001);
    await expect.poll(orbitGain, { timeout: 5000, interval: 50 }).toBe(0);
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
    expect(await readSamplePlaybackRates(page, 'satellite-equip')).toEqual([1]);
    expect((await readSamplePlaybackRates(page, 'interface')).length).toBeGreaterThanOrEqual(3);
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
    await page.locator('#soundPref').evaluate((input) => {
      if (!(input instanceof HTMLInputElement)) {
        throw new Error('Sound checkbox missing');
      }
      input.checked = false;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await expect
      .poll(() => page.evaluate(() => document.documentElement.dataset['activeTones']))
      .toBe('0');
    await page.locator('#soundPref').evaluate((input) => {
      if (!(input instanceof HTMLInputElement)) {
        throw new Error('Sound checkbox missing');
      }
      input.checked = true;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await expect
      .poll(() => page.evaluate(() => document.documentElement.dataset['activeTones']))
      .toBe('2');
    await page.evaluate(() => window.gameController?.getNetworkManager().disconnect());
    await expect
      .poll(() => page.evaluate(() => document.documentElement.dataset['activeTones']))
      .toBe('0');
    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
  },
  TestConfig.DEFAULT_TIMEOUT
);
