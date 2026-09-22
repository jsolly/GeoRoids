import { expect, test } from 'vitest';
import { installAudioProbe, readSamplePlaybackRates } from '../../utils/audio-probe';
import {
  assertNoBrowserDiagnostics,
  watchBrowserDiagnostics,
} from '../../utils/browser-diagnostics';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';
import { TestConfig } from '../../utils/test-config';
import { arrangeCrewField } from '../../utils/test-server-control';

const { browserManager, screenshotManager } = createBrowserScenarioHooks(__dirname);
const ROCK_ID = 'crew-fixture-ore';

test.each([
  { width: 1280, height: 900 },
  { width: 390, height: 844 },
])(
  'Hauler equips, arms, and ignites a furnace-guided asteroid at $width pixels',
  async (viewport) => {
    const mobile = viewport.width < 600;
    const page = await browserManager.recreatePage({ hasTouch: mobile });
    await page.setViewportSize(viewport);
    const diagnostics = watchBrowserDiagnostics(page);
    await installAudioProbe(page);
    const game = new GameInteractions(page);
    await game.bootGame({ kitId: 'hauler', waitForCombatReady: false });
    if (mobile) {
      await page.locator('#ship-schematic-toggle').tap();
    } else {
      await page.keyboard.press('KeyV');
    }
    await page.locator('#ship-schematic-dialog').waitFor({ state: 'visible' });
    const coupling = page.getByRole('button', { name: /Boost Coupling/u });
    await coupling.click();
    expect(await coupling.getAttribute('aria-pressed')).toBe('true');
    expect(await page.locator('#ship-schematic-part-copy').textContent()).toContain(
      'nearest furnace'
    );
    await page.screenshot({
      path: screenshotManager.getScreenshotPath(`boost-schematic-${viewport.width}.png`),
    });
    await page.getByRole('button', { name: 'Return to flight' }).click();
    const playerId = await game.getLocalPlayerId();
    await arrangeCrewField([playerId], 'delivery');
    await page.waitForFunction(
      (id) =>
        window.gameController
          ?.getCurrRoidBelt()
          .getRoids()
          .some((r) => r.id === id),
      ROCK_ID
    );
    const activate = () =>
      mobile ? page.locator('#touch-ability').tap() : page.keyboard.press('KeyE');
    await activate();
    await page.waitForFunction(
      (id) =>
        window.gameController
          ?.getCurrRoidBelt()
          .getRoids()
          .find((candidate) => candidate.id === id)?.boost?.phase === 'armed',
      ROCK_ID
    );
    const armed = await page.evaluate((id) => {
      const rock = window.gameController
        ?.getCurrRoidBelt()
        .getRoids()
        .find((candidate) => candidate.id === id);
      if (!rock?.boost) {
        throw new Error('No armed asteroid');
      }
      return {
        angle: rock.boost.angle,
        position: { ...rock.position },
        velocity: { ...rock.velocity },
      };
    }, ROCK_ID);
    expect(armed.velocity).toEqual({ x: 0, y: 0 });
    if (mobile) {
      await page.waitForFunction(
        () => document.querySelector('#touch-ability')?.textContent === 'IGNITE'
      );
    }
    await page.screenshot({
      path: screenshotManager.getScreenshotPath(`boost-armed-${viewport.width}.png`),
    });
    await activate();
    await page.waitForFunction((id) => {
      const c = window.gameController;
      const r = c
        ?.getCurrRoidBelt()
        .getRoids()
        .find((candidate) => candidate.id === id);
      return (
        c?.getCurrPlayer()?.ship.harpoonTargetId === null &&
        r?.boost?.phase === 'burning' &&
        Math.hypot(r.velocity.x, r.velocity.y) > 1.2
      );
    }, ROCK_ID);
    const burning = await page.evaluate(
      (id) =>
        window.gameController
          ?.getCurrRoidBelt()
          .getRoids()
          .find((candidate) => candidate.id === id)?.boost,
      ROCK_ID
    );
    expect(burning?.angle).toBeCloseTo(armed.angle);
    expect(await readSamplePlaybackRates(page, 'boost-ignite')).toEqual([1]);
    await page.screenshot({
      path: screenshotManager.getScreenshotPath(`boost-burning-${viewport.width}.png`),
    });
    await page.waitForFunction(
      (id) =>
        window.gameController
          ?.getCurrRoidBelt()
          .getRoids()
          .every((candidate) => candidate.id !== id),
      ROCK_ID,
      { timeout: 5000 }
    );
    await page.waitForFunction(() => (window.gameController?.getCurrPlayer()?.score ?? 0) > 0);
    await page.screenshot({
      path: screenshotManager.getScreenshotPath(`boost-delivered-${viewport.width}.png`),
    });
    assertNoBrowserDiagnostics(diagnostics);
  },
  TestConfig.DEFAULT_TIMEOUT
);
