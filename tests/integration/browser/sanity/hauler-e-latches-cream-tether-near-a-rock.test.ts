import type { Page } from 'playwright';
import { expect, test } from 'vitest';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';
import { TestConfig } from '../../utils/test-config';

const { browserManager, screenshotManager } = createBrowserScenarioHooks(__dirname);

const CREAM = '#E8D5A3';
const TIP = '#FDE68A';

type ApproachState =
  | { ok: true; gap: number; delta: number }
  | { ok: false; reason: 'missing' | 'dead' };

async function flyWasdNearRock(page: Page, targetId: string, timeoutMs = 25_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let held: 'KeyA' | 'KeyD' | 'KeyW' | null = null;
  const hold = async (key: 'KeyA' | 'KeyD' | 'KeyW' | null) => {
    if (held === key) {
      return;
    }
    if (held) {
      await page.keyboard.up(held);
    }
    if (key) {
      await page.keyboard.down(key);
    }
    held = key;
  };
  try {
    while (Date.now() < deadline) {
      const nav = await page.evaluate((id): ApproachState => {
        const gc = window.gameController;
        const ship = gc?.getCurrPlayer()?.ship;
        const rock = gc
          ?.getCurrRoidBelt?.()
          ?.getRoids?.()
          .find((candidate) => candidate.id === id);
        if (!ship || !rock) {
          return { ok: false, reason: 'missing' };
        }
        if (ship.exploding || ship.health <= 0) {
          return { ok: false, reason: 'dead' };
        }
        const dx = rock.position.x - ship.position.x;
        const dy = rock.position.y - ship.position.y;
        const dist = Math.hypot(dx, dy);
        const desired = Math.atan2(-dy, dx);
        let delta = desired - ship.angle;
        while (delta > Math.PI) {
          delta -= Math.PI * 2;
        }
        while (delta < -Math.PI) {
          delta += Math.PI * 2;
        }
        return { ok: true, gap: dist - ship.r - rock.r, delta };
      }, targetId);
      if (!nav.ok) {
        await hold(null);
        // A bot kill mid-approach must not abort the title→E path.
        await page.waitForTimeout(nav.reason === 'dead' ? 250 : 80);
        continue;
      }
      if (nav.gap <= 420) {
        await hold(null);
        return;
      }
      if (Math.abs(nav.delta) > 0.18) {
        await hold(nav.delta > 0 ? 'KeyA' : 'KeyD');
      } else {
        await hold('KeyW');
      }
      await page.waitForTimeout(50);
    }
    throw new Error('WASD approach did not reach a nearby rock');
  } finally {
    if (held) {
      await page.keyboard.up(held);
    }
    await page.keyboard.up('KeyA');
    await page.keyboard.up('KeyD');
    await page.keyboard.up('KeyW');
  }
}

test(
  'Hauler title kit, WASD to a nearby rock, and E paint cream tether plus tip',
  async () => {
    const page = browserManager.getCurrentPage();
    if (!page) {
      throw new Error('Page not available');
    }

    await page.setViewportSize({ width: 1280, height: 720 });
    const consoleErrors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') {
        consoleErrors.push(message.text());
      }
    });
    page.on('pageerror', (error) => consoleErrors.push(error.message));
    const game = new GameInteractions(page);
    await game.navigateToGame();
    const haulerKit = page.locator('[data-kit-id="hauler"]');
    await haulerKit.waitFor({ state: 'visible', timeout: 5000 });
    await haulerKit.click();
    await page.locator('#playerNameInput').focus();
    await page.keyboard.press('Enter');
    await page.locator('#gameArea').waitFor({ state: 'visible', timeout: 5000 });
    await game.waitForGameReady();
    await game.waitForServerJoin();
    await game.waitForNetworkAsteroids(1);
    await page.bringToFront();
    await game.waitForAsteroids(1);

    const fixture = await page.evaluate(() => {
      const gc = window.gameController;
      const player = gc?.getCurrPlayer();
      const ship = player?.ship;
      const rocks = (gc?.getCurrRoidBelt?.()?.getRoids?.() ?? []).filter(
        (candidate) => candidate.health > 0
      );
      if (!ship || rocks.length === 0) {
        throw new Error('Hauler fixture requires the local ship and a live asteroid');
      }
      const target = [...rocks].sort((left, right) => {
        const leftGap =
          Math.hypot(left.position.x - ship.position.x, left.position.y - ship.position.y) -
          left.r -
          ship.r;
        const rightGap =
          Math.hypot(right.position.x - ship.position.x, right.position.y - ship.position.y) -
          right.r -
          ship.r;
        return leftGap - rightGap;
      })[0];
      if (!target) {
        throw new Error('Hauler fixture did not find a live asteroid');
      }
      return {
        targetId: target.id,
        kitId: ship.kitId,
        selected: document.querySelector('[data-kit-id="hauler"]')?.getAttribute('aria-pressed'),
        joined: Boolean(gc?.getNetworkManager?.()?.getLocalPlayerId?.()),
      };
    });
    expect(fixture.kitId).toBe('hauler');
    expect(fixture.selected).toBe('true');
    expect(fixture.joined).toBe(true);

    await flyWasdNearRock(page, fixture.targetId);
    await page.keyboard.press('KeyE');

    const frames: Array<Record<string, unknown>> = [];
    const sampleDeadline = Date.now() + 1000;
    while (Date.now() < sampleDeadline) {
      const sample = await page.evaluate(
        ({ colors }: { colors: { cream: string; tip: string } }) => {
          const gc = window.gameController;
          gc?.renderGame?.();
          const ship = gc?.getCurrPlayer()?.ship;
          const probe = gc?.diagnoseHarpoon?.();
          const canvas = document.querySelector('#gameCanvas') as HTMLCanvasElement | null;
          const ctx = canvas?.getContext('2d');
          const pixels =
            ctx && canvas ? ctx.getImageData(0, 0, canvas.width, canvas.height).data : null;
          const near = (hex: string, tolerance: number): boolean => {
            if (!pixels) {
              return false;
            }
            const r = Number.parseInt(hex.slice(1, 3), 16);
            const g = Number.parseInt(hex.slice(3, 5), 16);
            const b = Number.parseInt(hex.slice(5, 7), 16);
            for (let i = 0; i < pixels.length; i += 4) {
              if (
                Math.abs((pixels[i] ?? 0) - r) <= tolerance &&
                Math.abs((pixels[i + 1] ?? 0) - g) <= tolerance &&
                Math.abs((pixels[i + 2] ?? 0) - b) <= tolerance &&
                (pixels[i + 3] ?? 0) > 180
              ) {
                return true;
              }
            }
            return false;
          };
          return {
            kitId: ship?.kitId,
            findTarget: probe?.targetId ?? probe?.liveTargetId ?? null,
            harpoonTimer: ship?.harpoonTimer ?? 0,
            latchPos: ship?.harpoonLatchPos ?? null,
            fieldCount: probe?.fieldCount ?? 0,
            nearest: probe?.nearest ?? null,
            cream: near(colors.cream, 22),
            tip: near(colors.tip, 22),
          };
        },
        { colors: { cream: CREAM, tip: TIP } }
      );
      frames.push(sample);
      if (sample.cream && sample.tip && sample.harpoonTimer > 0) {
        break;
      }
      await page.waitForTimeout(16);
    }

    const best =
      [...frames].reverse().find((frame) => frame['cream'] && frame['tip']) ?? frames.at(-1);
    expect(best?.['kitId']).toBe('hauler');
    expect(best?.['harpoonTimer']).toBeGreaterThan(0);
    expect(best?.['latchPos']).toBeTruthy();
    expect(best?.['cream']).toBe(true);
    expect(best?.['tip']).toBe(true);

    await page.screenshot({
      path: screenshotManager.getScreenshotPath('hauler-live-tether.png'),
    });
    expect(consoleErrors).toEqual([]);
  },
  TestConfig.DEFAULT_TIMEOUT
);
