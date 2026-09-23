import type { Page } from 'playwright';
import { expect, test } from 'vitest';
import { furnaceReward, TOWN_HEARTH } from '../../../../shared/furnaces';
import { computeHudLayout } from '../../../../src/rendering/hud/hudLayout';
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

const FIXTURE_ASTEROID_ID = 'crew-fixture-ore';
const DELIVERY_REWARD = furnaceReward({ id: 'test', ore: 'metal', material: 'metal', size: 25 });

type CrewState = {
  score: number;
  pickupMessage: string;
  asteroid: {
    id: string;
    surveyedBy: string[];
    x: number;
    y: number;
  } | null;
  local: {
    id: string;
    kitId: string;
    x: number;
    y: number;
    towId: string | null;
    activeFrames: number;
  };
};

function readCrewState(page: Page): Promise<CrewState> {
  return page.evaluate((asteroidId) => {
    const controller = window.gameController;
    const local = controller?.getCurrPlayer();
    const asteroid = controller
      ?.getCurrRoidBelt?.()
      ?.getRoids?.()
      .find((rock) => rock.id === asteroidId);
    if (!controller || !local) {
      throw new Error('Crew delivery fixture lost its local pilot');
    }
    return {
      score: controller.getCurrScore(),
      pickupMessage: controller.getGameStateManager().getPickupMessage(),
      asteroid: asteroid
        ? {
            id: asteroid.id,
            surveyedBy: [...(asteroid.surveyedBy ?? [])],
            x: asteroid.position.x,
            y: asteroid.position.y,
          }
        : null,
      local: {
        id: local.id,
        kitId: local.ship.kitId,
        x: local.ship.position.x,
        y: local.ship.position.y,
        towId: local.ship.harpoonTargetId,
        activeFrames: local.ship.abilityActiveFrames,
      },
    };
  }, FIXTURE_ASTEROID_ID);
}

async function waitForFixture(
  page: Page,
  kitId: 'hauler' | 'scout',
  expectedPosition: { x: number; y: number }
): Promise<void> {
  await page.waitForFunction(
    ({ asteroidId, expectedKit, expectedPosition: targetPosition }) => {
      const controller = window.gameController;
      const local = controller?.getCurrPlayer();
      const asteroid = controller
        ?.getCurrRoidBelt?.()
        ?.getRoids?.()
        .find((rock) => rock.id === asteroidId);
      return (
        local?.ship.kitId === expectedKit &&
        asteroid?.health === 75 &&
        local !== undefined &&
        Math.hypot(
          local.ship.position.x - targetPosition.x,
          local.ship.position.y - targetPosition.y
        ) < 20
      );
    },
    { asteroidId: FIXTURE_ASTEROID_ID, expectedKit: kitId, expectedPosition },
    { timeout: 5000, polling: 50 }
  );
}

async function pointHaulerNorth(page: Page): Promise<void> {
  const canvas = await page.locator('#gameCanvas').boundingBox();
  if (!canvas) {
    throw new Error('Crew delivery fixture cannot find the Hauler canvas');
  }
  await page.mouse.move(canvas.x + canvas.width / 2, canvas.y + canvas.height * 0.12);
}

async function assertMapButtonClearOfRadar(page: Page): Promise<void> {
  const actual = await page.evaluate(() => {
    const gameArea = document.querySelector('#gameArea');
    const mapButton = document.querySelector('#universe-map-toggle');
    if (!gameArea || !mapButton) {
      throw new Error('Map button geometry requires the game area and Map button');
    }
    const gameRect = gameArea.getBoundingClientRect();
    const buttonRect = mapButton.getBoundingClientRect();
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      gameArea: { left: gameRect.left, top: gameRect.top },
      button: {
        left: buttonRect.left - gameRect.left,
        right: buttonRect.right - gameRect.left,
        top: buttonRect.top - gameRect.top,
        bottom: buttonRect.bottom - gameRect.top,
      },
    };
  });
  const layout = computeHudLayout(actual.viewport, {
    touchControls: true,
    safeArea: { top: 0, right: 0, bottom: 0, left: 0 },
  });
  const { x, y, size } = layout.miniMap;
  // The radar readout occupies y - 32 through y - 5, followed by the radar
  // ring. The Map button must leave that canvas-drawn region readable.
  const radarAndReadout = { left: x, right: x + size, top: y - 32, bottom: y + size };
  const button = actual.button;
  const disjoint =
    button.right <= radarAndReadout.left ||
    button.left >= radarAndReadout.right ||
    button.bottom <= radarAndReadout.top ||
    button.top >= radarAndReadout.bottom;
  expect(disjoint).toBe(true);
  expect(button.left).toBeGreaterThanOrEqual(-1);
  expect(button.right).toBeLessThanOrEqual(actual.viewport.width + 1);
  expect(button.top).toBeGreaterThanOrEqual(-1);
  expect(button.bottom).toBeLessThanOrEqual(actual.viewport.height + 1);
}

test(
  'Scout scans a rock for the crew, Hauler tows it to Town Square, and both score on desktop and mobile',
  async () => {
    const haulerPage = browserManager.getCurrentPage();
    if (!haulerPage) {
      throw new Error('Hauler page unavailable');
    }
    const scoutPage = await browserManager.createAdditionalPage({ hasTouch: true });
    const haulerDiagnostics = watchBrowserDiagnostics(haulerPage);
    const scoutDiagnostics = watchBrowserDiagnostics(scoutPage);
    await installAudioProbe(haulerPage);
    await installAudioProbe(scoutPage);
    const hauler = new GameInteractions(haulerPage);
    const scout = new GameInteractions(scoutPage);

    await haulerPage.setViewportSize({ width: 1280, height: 900 });
    await scoutPage.setViewportSize({ width: 390, height: 844 });
    await hauler.bootGame({
      kitId: 'hauler',
      haulerUtility: 'tow_cable',
      waitForCombatReady: false,
    });
    await scout.bootGame({ kitId: 'scout', waitForCombatReady: false });

    const haulerId = await hauler.getLocalPlayerId();
    const scoutId = await scout.getLocalPlayerId();
    await Promise.all([hauler.waitForRemotePlayers(1), scout.waitForRemotePlayers(1)]);

    await arrangeCrewField([haulerId, scoutId], 'delivery');
    await Promise.all([hauler.placeShipAt(0, 550), scout.placeShipAt(220, 460)]);
    await Promise.all([
      waitForFixture(haulerPage, 'hauler', { x: 0, y: 550 }),
      waitForFixture(scoutPage, 'scout', { x: 220, y: 460 }),
    ]);

    expect(TOWN_HEARTH.position).toEqual({ x: 0, y: 0 });
    const scoresBefore = await Promise.all([hauler.getScore(), scout.getScore()]);

    // The Scout's real E input records the tag. The remote Hauler snapshot
    // must carry the same contributor before the tow begins.
    await scoutPage.locator('#touch-ability').tap();
    await expect
      .poll(
        async () => {
          const state = await readCrewState(scoutPage);
          return state.asteroid?.surveyedBy.includes(scoutId) === true;
        },
        { timeout: 5000, message: 'Scout E should persist its contributor tag' }
      )
      .toBe(true);
    await expect
      .poll(
        async () => {
          const state = await readCrewState(haulerPage);
          const remoteScoutActiveFrames = await haulerPage.evaluate(
            (id) =>
              window.gameController
                ?.getNetworkManager()
                .getAllPlayers()
                .find((player) => player.id === id)?.ship.abilityActiveFrames ?? 0,
            scoutId
          );
          return (
            state.asteroid?.surveyedBy.includes(scoutId) === true && remoteScoutActiveFrames > 0
          );
        },
        { timeout: 5000, message: 'Hauler radar should receive the Scout scan state' }
      )
      .toBe(true);

    // E attaches the real persistent cable. Pointing north supplies ordinary
    // movement input; the fixture itself never moves the result or awards score.
    await pointHaulerNorth(haulerPage);
    await haulerPage.keyboard.press('KeyE');
    await expect
      .poll(async () => (await readCrewState(haulerPage)).local.towId, {
        timeout: 5000,
        message: 'Hauler E should attach the fixture asteroid',
      })
      .toBe(FIXTURE_ASTEROID_ID);
    const attached = await readCrewState(haulerPage);
    if (!attached.asteroid) {
      throw new Error('Tow fixture disappeared immediately after attachment');
    }
    const attachedAsteroidY = attached.asteroid.y;
    await expect
      .poll(
        async () => {
          const state = await readCrewState(haulerPage);
          if (!state.asteroid) {
            return 'delivered';
          }
          return state.local.towId === FIXTURE_ASTEROID_ID && state.asteroid.y < attachedAsteroidY
            ? 'towing'
            : 'waiting';
        },
        { timeout: 15000, message: 'Hauler should tow the rock into Town Square' }
      )
      .toBe('delivered');

    await expect
      .poll(() => hauler.getScore(), {
        timeout: 5000,
        message: 'Hauler should receive the full furnace delivery reward',
      })
      .toBe(scoresBefore[0] + DELIVERY_REWARD);
    await expect
      .poll(() => scout.getScore(), {
        timeout: 5000,
        message: 'Scout contributor should receive the same furnace delivery reward',
      })
      .toBe(scoresBefore[1] + DELIVERY_REWARD);

    await expect
      .poll(async () => (await readCrewState(haulerPage)).pickupMessage, {
        timeout: 3000,
        message: 'Hauler should show the shared delivery banner',
      })
      .toBe(`Team delivery +${DELIVERY_REWARD} each`);
    await expect
      .poll(async () => (await readCrewState(scoutPage)).pickupMessage, {
        timeout: 3000,
        message: 'Scout should show the shared delivery banner',
      })
      .toBe(`Team delivery +${DELIVERY_REWARD} each`);
    await assertMapButtonClearOfRadar(scoutPage);

    await haulerPage.screenshot({
      path: screenshotManager.getScreenshotPath('crew-delivery-hauler-desktop.png'),
    });
    await scoutPage.screenshot({
      path: screenshotManager.getScreenshotPath('crew-delivery-scout-mobile.png'),
    });
    expect(await readSamplePlaybackRates(haulerPage, 'delivery')).toEqual([1]);
    expect(await readSamplePlaybackRates(scoutPage, 'delivery')).toEqual([1]);
    assertNoBrowserDiagnostics(haulerDiagnostics);
    assertNoBrowserDiagnostics(scoutDiagnostics);
  },
  TestConfig.DEFAULT_TIMEOUT * 2
);
