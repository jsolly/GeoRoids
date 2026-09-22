import { expect, test } from 'vitest';
import {
  assertNoBrowserDiagnostics,
  watchBrowserDiagnostics,
} from '../../utils/browser-diagnostics';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';
import { TestConfig } from '../../utils/test-config';
import { arrangeCrewField } from '../../utils/test-server-control';

const { browserManager, screenshotManager } = createBrowserScenarioHooks();

for (const viewport of [
  { width: 1280, height: 900, touch: false },
  { width: 390, height: 844, touch: true },
]) {
  test(`Surveyor equips and fires a shared moving beacon at ${viewport.width} pixels`, async () => {
    const page = await browserManager.recreatePage({ hasTouch: viewport.touch });
    await page.setViewportSize(viewport);
    const diagnostics = watchBrowserDiagnostics(page);
    const game = new GameInteractions(page);
    await game.bootGame({ kitId: 'surveyor', waitForCombatReady: false });
    const observer = await browserManager.createPage();
    const observerDiagnostics = watchBrowserDiagnostics(observer);
    const hauler = new GameInteractions(observer);
    await hauler.bootGame({ kitId: 'hauler', waitForCombatReady: false });
    const playerId = await game.getLocalPlayerId();
    const observerId = await hauler.getLocalPlayerId();
    await arrangeCrewField([playerId, observerId], 'empty');
    await page.bringToFront();
    if (viewport.touch) {
      await page.locator('#ship-schematic-toggle').tap();
    } else {
      await page.keyboard.press('KeyV');
    }
    await page.locator('#ship-schematic-dialog').waitFor({ state: 'visible' });
    const card = page.locator('[data-utility-id="survey_probe"]');
    if (viewport.touch) {
      await card.tap();
    } else {
      await card.click();
    }
    expect(await card.getAttribute('aria-pressed')).toBe('true');
    await page.screenshot({
      path: screenshotManager.getScreenshotPath(`probe-tools-${viewport.width}.png`),
    });
    const back = page.getByRole('button', { name: 'Return to flight' });
    if (viewport.touch) {
      await back.tap();
    } else {
      await back.click();
    }
    await arrangeCrewField([playerId, observerId], 'probe');
    await page.mouse.move(viewport.width * 0.9, viewport.height / 2);
    await page.waitForFunction(() => {
      const ship = window.gameController?.getCurrPlayer()?.ship;
      return ship && Math.abs(Math.sin(ship.angle)) < 0.03 && Math.cos(ship.angle) > 0;
    });
    if (viewport.touch) {
      expect((await page.locator('#touch-ability').textContent())?.toUpperCase()).toContain(
        'PROBE'
      );
      await page.locator('#touch-ability').tap();
    } else {
      await page.keyboard.press('KeyE');
    }
    await page.waitForFunction(() =>
      window.gameController
        ?.getCurrRoidBelt()
        .getRoids()
        .some((rock) => rock.id === 'crew-fixture-probe-host' && rock.probe)
    );
    const initial = await page.evaluate(() => {
      const rock = window.gameController
        ?.getCurrRoidBelt()
        .getRoids()
        .find((item) => item.id === 'crew-fixture-probe-host');
      if (!rock?.probe) {
        throw new Error('Probe did not attach');
      }
      return { id: rock.probe.id, health: rock.probe.health, x: rock.position.x };
    });
    expect(initial.health).toBe(40);
    await observer.waitForFunction(
      ({ id, owner }) => {
        const rocks = window.gameController?.getCurrRoidBelt().getRoids();
        return (
          rocks?.some((rock) => rock.probe?.id === id) &&
          rocks.some(
            (rock) => rock.id === 'crew-fixture-probe-deposit' && rock.surveyedBy?.includes(owner)
          )
        );
      },
      { id: initial.id, owner: playerId }
    );
    await page.waitForFunction(
      ({ x }) =>
        window.gameController
          ?.getCurrRoidBelt()
          .getRoids()
          .some(
            (rock) =>
              rock.id === 'crew-fixture-probe-host' && rock.probe && rock.position.x > x + 0.5
          ),
      initial
    );
    await page.waitForFunction(() => {
      const probe = window.gameController
        ?.getCurrRoidBelt()
        .getRoids()
        .find((rock) => rock.id === 'crew-fixture-probe-host')?.probe;
      if (!probe) {
        return false;
      }
      const phase = (Date.now() - probe.attachedAt) % 3000;
      return phase >= 750 && phase <= 1350;
    });
    await page.screenshot({
      path: screenshotManager.getScreenshotPath(`probe-flight-${viewport.width}.png`),
    });
    // The Wiki is a separate entry: verify its new rules at each viewport too.
    await page.goto(`${TestConfig.GAME_URL}/wiki/#surveyor`);
    await page.getByRole('heading', { name: 'Survey probe', exact: true }).waitFor();
    await page.getByRole('heading', { name: 'Survey probe', exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({
      path: screenshotManager.getScreenshotPath(`probe-wiki-${viewport.width}.png`),
    });
    assertNoBrowserDiagnostics(diagnostics);
    assertNoBrowserDiagnostics(observerDiagnostics);
  }, 30000);
}
