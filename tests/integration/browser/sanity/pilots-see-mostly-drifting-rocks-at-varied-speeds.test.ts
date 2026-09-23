import { expect, test } from 'vitest';
import {
  assertNoBrowserDiagnostics,
  watchBrowserDiagnostics,
} from '../../utils/browser-diagnostics';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';
import { TestConfig } from '../../utils/test-config';

const { browserManager, screenshotManager } = createBrowserScenarioHooks(__dirname);

test.each([
  { width: 1280, height: 900 },
  { width: 390, height: 844 },
])(
  'pilots see slow and fast drifting rocks alongside stationary targets at $width pixels',
  async (viewport) => {
    const page = await browserManager.recreatePage({ hasTouch: viewport.width < 600 });
    await page.setViewportSize(viewport);
    const diagnostics = watchBrowserDiagnostics(page);
    const game = new GameInteractions(page);
    await game.bootGame({ waitForCombatReady: false });
    await game.armSpawnProtection();
    await page.waitForFunction(
      () => (window.gameController?.getCurrRoidBelt().getRoids().length ?? 0) > 30
    );
    const before = await page.evaluate(
      () =>
        window.gameController
          ?.getCurrRoidBelt()
          .getRoids()
          .map((rock) => ({
            id: rock.id,
            position: { ...rock.position },
            speed: Math.hypot(rock.velocity.x, rock.velocity.y),
          })) ?? []
    );
    const moving = before.filter((rock) => rock.speed > 0);
    expect(moving.length / before.length).toBeGreaterThan(0.6);
    expect(moving.length / before.length).toBeLessThan(0.95);
    expect(Math.max(...moving.map((rock) => rock.speed))).toBeGreaterThan(1.2);
    expect(Math.min(...moving.map((rock) => rock.speed))).toBeLessThan(0.4);
    // Observe near-spawn rocks so ordinary drift cannot carry them across the
    // network interest boundary during the measurement.
    const drifter = moving.find(
      (rock) => rock.speed > 1 && Math.hypot(rock.position.x, rock.position.y) < 800
    );
    const stationary = before.find(
      (rock) => rock.speed === 0 && Math.hypot(rock.position.x, rock.position.y) < 800
    );
    if (!drifter || !stationary) {
      throw new Error('Both drifting and stationary rocks required');
    }
    await page.waitForTimeout(500);
    const after = await page.evaluate(
      () =>
        window.gameController
          ?.getCurrRoidBelt()
          .getRoids()
          .map((rock) => ({ id: rock.id, position: { ...rock.position } })) ?? []
    );
    const moved = after.find((rock) => rock.id === drifter.id);
    const stayed = after.find((rock) => rock.id === stationary.id);
    expect(moved).toBeDefined();
    expect(stayed).toBeDefined();
    expect(
      Math.hypot(
        (moved?.position.x ?? drifter.position.x) - drifter.position.x,
        (moved?.position.y ?? drifter.position.y) - drifter.position.y
      )
    ).toBeGreaterThan(5);
    expect(stayed?.position).toEqual(stationary.position);
    await page.screenshot({
      path: screenshotManager.getScreenshotPath(`drifting-roids-${viewport.width}.png`),
    });
    await page.goto(`${TestConfig.GAME_URL}/wiki/#asteroids`);
    await page.locator('.game-reference summary').click();
    await page.getByText('Fresh interior sectors have', { exact: false }).waitFor();
    await page.screenshot({
      path: screenshotManager.getScreenshotPath(`drifting-roids-wiki-${viewport.width}.png`),
      fullPage: true,
    });
    assertNoBrowserDiagnostics(diagnostics);
  }
);
