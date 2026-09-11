import { expect, test } from 'vitest';
import { FACTION_COLORS } from '../../../../shared/factions';
import {
  assertNoBrowserDiagnostics,
  watchBrowserDiagnostics,
} from '../../utils/browser-diagnostics';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';
import { TestConfig } from '../../utils/test-config';

const { browserManager, screenshotManager } = createBrowserScenarioHooks(__dirname);

test.each([1280, 390])(
  'faction colors distinguish the two bots at %i pixels',
  async (width) => {
    const page = browserManager.getCurrentPage();
    if (!page) {
      throw new Error('Page unavailable');
    }
    const diagnostics = watchBrowserDiagnostics(page);
    await page.setViewportSize({ width, height: 900 });
    const game = new GameInteractions(page);
    await game.bootGame({ waitForCombatReady: false });
    await expect
      .poll(() =>
        page.evaluate(() =>
          (window.gameController?.getNetworkManager().getAllPlayers() ?? [])
            .filter((player) => player.type === 'bot')
            .map((player) => ({
              faction: player.factionId,
              color: player.color,
              hull: player.ship.color,
            }))
            .sort((a, b) => (a.faction ?? '').localeCompare(b.faction ?? ''))
        )
      )
      .toEqual([
        { faction: 'ember', color: FACTION_COLORS.ember, hull: FACTION_COLORS.ember },
        { faction: 'ion', color: FACTION_COLORS.ion, hull: FACTION_COLORS.ion },
      ]);
    await page.screenshot({
      path: screenshotManager.getScreenshotPath(`faction-colors-${width}.png`),
    });
    await page.goto(new URL('/wiki/#factions', page.url()).href);
    await page.locator('h1').waitFor();
    await page.screenshot({
      path: screenshotManager.getScreenshotPath(`faction-colors-wiki-${width}.png`),
      fullPage: true,
    });
    assertNoBrowserDiagnostics(diagnostics);
  },
  TestConfig.DEFAULT_TIMEOUT
);
