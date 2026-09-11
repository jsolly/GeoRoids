import type { Page } from 'playwright';
import { expect, test } from 'vitest';
import { SHIP_ABILITY } from '../../../../src/entities/ship/shipKits';
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
  'Hauler title kit, WASD to a nearby rock, and E shows a working sling tether',
  async () => {
    const page = browserManager.getCurrentPage();
    if (!page) {
      throw new Error('Page not available');
    }

    await page.setViewportSize({ width: 1280, height: 720 });
    const consoleErrors: string[] = [];
    const consoleWarnings: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'warning') {
        consoleWarnings.push(message.text());
      }
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
    const before = await page.evaluate((id) => {
      const gc = window.gameController;
      const ship = gc?.getCurrPlayer()?.ship;
      const rock = gc
        ?.getCurrRoidBelt?.()
        ?.getRoids?.()
        .find((candidate) => candidate.id === id);
      if (!ship || !rock) {
        throw new Error('Hauler fixture lost the selected rock before E');
      }
      return {
        speed: Math.hypot(rock.velocity.x, rock.velocity.y),
        velocity: { x: rock.velocity.x, y: rock.velocity.y },
        distance: Math.hypot(rock.position.x - ship.position.x, rock.position.y - ship.position.y),
      };
    }, fixture.targetId);
    await page.keyboard.press('KeyE');
    await page.waitForFunction((targetId) => {
      const gc = window.gameController;
      const ship = gc?.getCurrPlayer()?.ship;
      return ship && ship.harpoonTimer > 0 && ship.harpoonTargetId === targetId;
    }, fixture.targetId);

    const frames: Array<Record<string, unknown>> = [];
    const sampleDeadline = Date.now() + 1800;
    while (Date.now() < sampleDeadline) {
      const sample = await page.evaluate(
        ({
          colors,
          releaseGap,
          readPixels,
        }: {
          colors: { cream: string; tip: string };
          releaseGap: number;
          readPixels: boolean;
        }) => {
          const gc = window.gameController;
          gc?.renderGame?.();
          const ship = gc?.getCurrPlayer()?.ship;
          const probe = gc?.diagnoseHarpoon?.();
          const canvas = document.querySelector('#gameCanvas') as HTMLCanvasElement | null;
          const ctx = canvas?.getContext('2d');
          const pixels =
            readPixels && ctx && canvas
              ? ctx.getImageData(0, 0, canvas.width, canvas.height).data
              : null;
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
          const latched = gc
            ?.getCurrRoidBelt?.()
            ?.getRoids?.()
            .find((rock) => rock.id === ship?.harpoonTargetId);
          const distance =
            ship && latched
              ? Math.hypot(
                  latched.position.x - ship.position.x,
                  latched.position.y - ship.position.y
                )
              : Number.POSITIVE_INFINITY;
          return {
            active: Boolean(ship && latched && ship.harpoonTimer > 0),
            speed: latched ? Math.hypot(latched.velocity.x, latched.velocity.y) : 0,
            distance,
            gap: latched && ship ? distance - ship.r - latched.r : Number.POSITIVE_INFINITY,
            releaseRadius: releaseGap,
            velocity: latched ? { x: latched.velocity.x, y: latched.velocity.y } : { x: 0, y: 0 },
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
        {
          colors: { cream: CREAM, tip: TIP },
          releaseGap: SHIP_ABILITY.HARPOON_RELEASE_GAP,
          readPixels: frames.length === 0,
        }
      );
      frames.push(sample);
      if (
        frames.length > 1 &&
        sample.active &&
        sample.gap <= SHIP_ABILITY.HARPOON_RELEASE_GAP + 2 &&
        sample.speed >= SHIP_ABILITY.HARPOON_SLING_SPEED - 0.1
      ) {
        break;
      }
      await page.waitForTimeout(16);
    }

    const activeFrames = frames.filter((frame) => frame['active'] === true);
    const firstActive = activeFrames.at(0);
    const minimumDistance = Math.min(
      ...activeFrames.map((frame) => Number(frame['distance'] ?? Number.POSITIVE_INFINITY))
    );
    const reelObserved =
      firstActive !== undefined && minimumDistance < Number(firstActive['distance']) - 12;
    const firstVelocity = firstActive?.['velocity'] as { x?: number; y?: number } | undefined;
    const firstSpeed = Number(firstActive?.['speed'] ?? 0);
    const firstVelocityMagnitude = Math.hypot(
      Number(firstVelocity?.x ?? 0),
      Number(firstVelocity?.y ?? 0)
    );
    const initialVelocityMagnitude = Math.hypot(before.velocity.x, before.velocity.y);
    const straightHeading =
      initialVelocityMagnitude > 0 &&
      firstVelocityMagnitude > 0 &&
      (before.velocity.x * Number(firstVelocity?.x ?? 0) +
        before.velocity.y * Number(firstVelocity?.y ?? 0)) /
        (initialVelocityMagnitude * firstVelocityMagnitude) >=
        SHIP_ABILITY.HARPOON_PATH_ALIGNMENT - 0.02;
    const straightObserved =
      straightHeading &&
      firstSpeed >= Math.max(Number(before.speed), SHIP_ABILITY.HARPOON_SLING_SPEED) - 0.1;
    const releaseObserved = activeFrames.some(
      (frame) =>
        Number(frame['gap']) <= Number(frame['releaseRadius']) + 2 &&
        Number(frame['speed']) >= SHIP_ABILITY.HARPOON_SLING_SPEED - 0.1
    );
    const alreadyNearHull = Number(firstActive?.['gap']) <= SHIP_ABILITY.HARPOON_RELEASE_GAP;
    const launched = activeFrames.some(
      (frame) =>
        Math.abs(
          Number(frame['speed']) - Math.max(before.speed, SHIP_ABILITY.HARPOON_SLING_SPEED)
        ) < 0.1
    );
    const evidence = JSON.stringify({ before, frames });
    expect(reelObserved || straightObserved || alreadyNearHull, evidence).toBe(true);
    expect(releaseObserved || straightObserved || (alreadyNearHull && launched), evidence).toBe(
      true
    );
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
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: screenshotManager.getScreenshotPath('hauler-sling-mobile.png') });
    await page.goto(new URL('/wiki/#hauler', page.url()).href);
    await page
      .getByText('Other latched asteroids reel toward the Hauler', { exact: false })
      .waitFor();
    await page.screenshot({
      path: screenshotManager.getScreenshotPath('hauler-wiki-mobile.png'),
      fullPage: true,
    });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.screenshot({
      path: screenshotManager.getScreenshotPath('hauler-wiki-desktop.png'),
      fullPage: true,
    });
    expect(consoleErrors).toEqual([]);
    expect(consoleWarnings).toEqual([]);
  },
  TestConfig.DEFAULT_TIMEOUT
);
