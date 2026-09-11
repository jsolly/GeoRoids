import { expect, test } from 'vitest';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';
import { captureConsole } from '../../utils/reflective-asteroids-driver';
import { TestConfig } from '../../utils/test-config';

const { browserManager, screenshotManager } = createBrowserScenarioHooks(__dirname);

test.each([
  { width: 1280, height: 900 },
  { width: 390, height: 844 },
])(
  'Hauler uses E without extra asteroid controls at $width pixels',
  async (viewport) => {
    const page = browserManager.getCurrentPage();
    if (!page) {
      throw new Error('Page unavailable');
    }
    await page.setViewportSize(viewport);
    const consoleState = captureConsole(page);
    const messages: string[] = [];
    page.on('websocket', (socket) =>
      socket.on('framesent', ({ payload }) => {
        const message = JSON.parse(String(payload));
        messages.push(message.type);
      })
    );
    await page.goto(TestConfig.GAME_URL);
    await expect
      .poll(() => page.locator('#controls-hint').textContent())
      .toMatch(viewport.width < 500 ? /Hold screen to steer/ : /WASD/);
    expect(await page.locator('#controls-hint').textContent()).not.toMatch(
      /target|latch|anchor|brake|spin|flick/i
    );
    await page.screenshot({
      path: screenshotManager.getScreenshotPath(`hauler-menu-${viewport.width}.png`),
    });
    const game = new GameInteractions(page);
    await game.bootGame({ kitId: 'hauler', waitForCombatReady: false });
    await game.waitForAsteroids(1);
    const target = await page.evaluate(() => {
      const gc = window.gameController;
      const rocks = gc?.getCurrRoidBelt().getRoids() ?? [];
      const clearance = (rock: (typeof rocks)[number]) =>
        Math.min(
          ...rocks
            .filter((other) => other.id !== rock.id)
            .map(
              (other) =>
                Math.hypot(other.position.x - rock.position.x, other.position.y - rock.position.y) -
                other.r -
                rock.r
            )
        );
      const rock = [...rocks].sort((a, b) => clearance(b) - clearance(a))[0];
      if (!rock) {
        throw new Error('Asteroid unavailable');
      }
      return { x: rock.position.x + rock.r + 100, y: rock.position.y };
    });
    await game.placeShipAt(target.x, target.y);
    for (const key of ['KeyT', 'KeyQ', 'KeyR', 'KeyX', 'KeyC']) {
      await page.keyboard.press(key);
    }
    const canvas = await page.locator('#gameCanvas').boundingBox();
    if (!canvas) {
      throw new Error('Canvas unavailable');
    }
    await page.mouse.click(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2, {
      button: 'middle',
    });
    const touch = await page.context().newCDPSession(page);
    try {
      const x = canvas.x + canvas.width / 2;
      const y = canvas.y + canvas.height / 2;
      await touch.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x, y, id: 7 }],
      });
      await touch.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x: x + 60, y, id: 7 }],
      });
      await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } finally {
      await touch.detach();
    }
    expect(messages.filter((type) => type === 'asteroidTool' || type === 'asteroidInput')).toEqual(
      []
    );
    expect(
      await page
        .locator('#flight-feedback, #flight-preview, #flight-selection-announcement')
        .count()
    ).toBe(0);
    await page.keyboard.press('KeyE');
    await expect
      .poll(() =>
        page.evaluate(() => window.gameController?.getCurrPlayer()?.ship.harpoonTimer ?? 0)
      )
      .toBeGreaterThan(0);
    expect(messages).toContain('useAbility');
    const healthBeforePull = await game.getShipHealth();
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const gc = window.gameController;
            const ship = gc?.getCurrPlayer()?.ship;
            const rock = gc
              ?.getCurrRoidBelt()
              .getRoids()
              .find((row) => row.id === ship?.harpoonTargetId);
            return Boolean(
              ship &&
                rock &&
                ship.harpoonTimer > 0 &&
                Math.hypot(ship.position.x - rock.position.x, ship.position.y - rock.position.y) <
                  rock.r
            );
          }),
        { timeout: 2500, interval: 20 }
      )
      .toBe(true);
    expect(await game.getShipHealth()).toBeGreaterThanOrEqual(healthBeforePull);
    await page.screenshot({
      path: screenshotManager.getScreenshotPath(`hauler-basic-${viewport.width}.png`),
    });
    await page.keyboard.down('KeyW');
    await expect
      .poll(() => page.evaluate(() => window.gameController?.getCurrPlayer()?.ship.thrusting))
      .toBe(true);
    await page.keyboard.up('KeyW');
    await page.keyboard.press('Space');
    await expect.poll(() => messages.includes('shoot')).toBe(true);
    await page.keyboard.press('KeyF');
    await expect
      .poll(() => page.evaluate(() => window.gameController?.getCurrPlayer()?.ship.shieldActive))
      .toBe(true);
    expect(consoleState.errors).toEqual([]);
    expect(consoleState.warnings).toEqual([]);
  },
  TestConfig.DEFAULT_TIMEOUT
);
