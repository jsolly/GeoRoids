import assert from 'node:assert/strict';
import { expect, test } from 'vitest';
import { SATELLITE_PICKUP } from '../../../../src/constants';
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
    const sent: string[] = [];
    page.on('websocket', (socket) =>
      socket.on('framesent', ({ payload }) => {
        sent.push(JSON.parse(String(payload)).type);
      })
    );
    const game = new GameInteractions(page);
    await game.bootSinglePlayerGame();
    await game.waitForSatellitePickups(2);

    const pickups = await game.getSatellitePickups();
    expect(pickups.length).toBeGreaterThanOrEqual(2);

    const target = pickups.find((pickup) => pickup.state === 'loose');
    assert.ok(target, 'Orbiting satellite pickup missing');
    const scoreBefore = await game.getScore();

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
    await page.screenshot({
      path: screenshotManager.getScreenshotPath(`satellite-auto-latch-${width}.png`),
    });
  },
  TestConfig.DEFAULT_TIMEOUT
);
