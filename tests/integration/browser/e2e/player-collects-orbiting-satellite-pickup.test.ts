import assert from 'node:assert/strict';
import { expect, test } from 'vitest';
import { SATELLITE_PICKUP } from '../../../../src/constants';
import { installAudioProbe } from '../../utils/audio-probe';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';
import { TestConfig } from '../../utils/test-config';

const { browserManager, screenshotManager } = createBrowserScenarioHooks(__dirname);

test.each([1280, 390])(
  'a nearby satellite automatically latches and keeps orbiting at %i pixels',
  async (width) => {
    const page = browserManager.getCurrentPage();
    if (!page) {
      throw new Error('Page not available');
    }

    await page.setViewportSize({ width, height: 900 });
    await installAudioProbe(page);
    const sent: string[] = [];
    page.on('websocket', (socket) =>
      socket.on('framesent', ({ payload }) => {
        sent.push(JSON.parse(String(payload)).type);
      })
    );
    const game = new GameInteractions(page);
    await game.bootGame();
    await game.waitForSatellitePickups(2);

    const pickups = await game.getSatellitePickups();
    expect(pickups.length).toBeGreaterThanOrEqual(2);

    const target = pickups.find((pickup) => pickup.state === 'loose');
    assert.ok(target, 'Orbiting satellite pickup missing');
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
          message: 'the collected satellite should orbit the player',
        }
      )
      .toBe('orbiting');

    await expect
      .poll(async () => game.getScore(), {
        timeout: 8000,
        message: 'collecting a satellite pickup should award points',
      })
      .toBeGreaterThanOrEqual(scoreBefore + SATELLITE_PICKUP.SCORE_BONUS);
    const attached = (await game.getSatellitePickups()).find((pickup) => pickup.id === target.id);
    expect(attached?.health).toBe(attached?.maxHealth);
    expect(sent).not.toContain('satellitePickupCollected');
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
      path: screenshotManager.getScreenshotPath(`satellite-auto-latch-${width}.png`),
    });
  },
  TestConfig.DEFAULT_TIMEOUT
);
