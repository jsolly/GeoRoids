import { expect, test } from 'vitest';
import { FURNACES } from '../../../../shared/furnaces';
import { WORLD } from '../../../../shared/world';
import {
  assertNoBrowserDiagnostics,
  watchBrowserDiagnostics,
} from '../../utils/browser-diagnostics';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';
import { TestConfig } from '../../utils/test-config';
import { arrangeCrewField } from '../../utils/test-server-control';

const { browserManager, screenshotManager } = createBrowserScenarioHooks(__dirname);
const REVEALED_ASSETS_STATUS_PATTERN = /\d+ revealed assets/u;

const FAR_FURNACE = (() => {
  const furnace = FURNACES.find((candidate) => candidate.id === 'works-1-0');
  if (!furnace) {
    throw new Error('Universe map fixture requires the first regional Works furnace');
  }
  return furnace;
})();

type MapFrame = {
  open: boolean;
  canvas: { width: number; height: number };
  status: string;
  labels: string[];
};

function readMapFrame(page: import('playwright').Page): Promise<MapFrame> {
  return page.evaluate(async () => {
    const dialog = document.querySelector('#universe-map-dialog');
    const canvas = document.querySelector('#universe-map-canvas');
    const status = document.querySelector('#universe-map-status');
    if (!(dialog instanceof HTMLDialogElement) || !(canvas instanceof HTMLCanvasElement)) {
      throw new Error('Universe map fixture requires its dialog and canvas');
    }

    const labels: string[] = [];
    const originalFillText = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (
      this: CanvasRenderingContext2D,
      text: string,
      x: number,
      y: number,
      maxWidth?: number
    ): void {
      if (this.canvas === canvas) {
        labels.push(text);
      }
      if (maxWidth === undefined) {
        originalFillText.call(this, text, x, y);
      } else {
        originalFillText.call(this, text, x, y, maxWidth);
      }
    };

    try {
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });
    } finally {
      CanvasRenderingContext2D.prototype.fillText = originalFillText;
    }

    return {
      open: dialog.open,
      canvas: { width: canvas.width, height: canvas.height },
      status: status?.textContent ?? '',
      labels,
    };
  });
}

async function openAndCaptureMap(
  page: import('playwright').Page,
  touch: boolean
): Promise<MapFrame> {
  if (touch) {
    await page.locator('#universe-map-toggle').tap();
  } else {
    await page.keyboard.press('KeyM');
  }
  await expect
    .poll(() => page.locator('#universe-map-dialog').isVisible(), {
      timeout: 5000,
      message: 'the full-screen universe map should open',
    })
    .toBe(true);
  await expect
    .poll(() => readMapFrame(page), {
      timeout: 5000,
      interval: 100,
      message: 'the universe map should render the discovered regional furnace label',
    })
    .toSatisfy((mapFrame: MapFrame) => mapFrame.open && mapFrame.labels.includes(FAR_FURNACE.name));
  const frame = await readMapFrame(page);
  expect(frame.canvas.width).toBeGreaterThan(0);
  expect(frame.canvas.height).toBeGreaterThan(0);
  expect(frame.status).toMatch(REVEALED_ASSETS_STATUS_PATTERN);
  expect(frame.labels).toContain(FAR_FURNACE.name);
  return frame;
}

test.each([
  { width: 1280, height: 900, touch: false, label: 'desktop keyboard shortcut' },
  { width: 390, height: 844, touch: true, label: 'mobile Map button' },
])(
  'the crew opens the full-screen map with the $label and keeps a discovered furnace marker',
  async ({ width, height, touch, label }) => {
    const page = touch
      ? await browserManager.recreatePage({ hasTouch: true })
      : browserManager.getCurrentPage();
    if (!page) {
      throw new Error(`Universe map page unavailable for ${label}`);
    }
    const diagnostics = watchBrowserDiagnostics(page);
    await page.setViewportSize({ width, height });

    const game = new GameInteractions(page);
    await game.bootGame({ kitId: 'surveyor', waitForCombatReady: false });
    const playerId = await game.getLocalPlayerId();
    await arrangeCrewField([playerId], 'empty');
    await game.placeShipAt(FAR_FURNACE.position.x, FAR_FURNACE.position.y);

    // Passive Surveyor exploration reveals the regional cell. The marker must
    // survive after the pilot returns home, outside the local minimap radius.
    const assets = await page.evaluateHandle<
      () => readonly import('../../../../shared-types').MapAsset[]
    >(
      "import('/src/network/worldExploration.ts').then(({ getWorldMapAssets }) => getWorldMapAssets)"
    );
    try {
      await expect
        .poll(
          () =>
            assets.evaluate(
              (readAssets, id) => readAssets().some((asset) => asset.id === id),
              `furnace:${FAR_FURNACE.id}`
            ),
          {
            timeout: 5000,
            message: 'the shared chart must receive the discovered furnace before departure',
          }
        )
        .toBe(true);
    } finally {
      await assets.dispose();
    }
    await game.placeShipAt(0, 0);
    expect(Math.hypot(FAR_FURNACE.position.x, FAR_FURNACE.position.y)).toBeGreaterThan(
      WORLD.minimapRadius
    );

    if (!touch) {
      await page.locator('#universe-map-toggle').focus();
    }
    const frame = await openAndCaptureMap(page, touch);
    expect(frame.labels).toContain('NORTH');
    const locations = page.getByRole('list', { name: 'Revealed landmarks and crew coordinates' });
    await expect.poll(() => locations.textContent(), { timeout: 5000 }).toContain(FAR_FURNACE.name);
    expect(await locations.textContent()).toContain('X +4000, Y +0');
    if (!touch) {
      await page.locator('#universe-map-canvas').focus();
      expect(
        await page
          .locator('#universe-map-canvas')
          .evaluate((canvas) => getComputedStyle(canvas).outlineStyle)
      ).not.toBe('none');
      await page.locator('#universe-map-zoom-in').focus();
      await page.keyboard.press('Space');
      await expect
        .poll(() => page.locator('#universe-map-zoom').textContent(), { timeout: 5000 })
        .toBe('135%');
    }
    await page.screenshot({
      path: screenshotManager.getScreenshotPath(
        `crew-universe-map-${touch ? 'mobile' : 'desktop'}.png`
      ),
    });

    if (touch) {
      await page.locator('#universe-map-close').tap();
    } else {
      await page.keyboard.press('KeyM');
    }
    await expect
      .poll(() => page.locator('#universe-map-dialog').isVisible(), {
        timeout: 5000,
        message: 'the universe map should close',
      })
      .toBe(false);
    if (!touch) {
      expect(await page.evaluate(() => document.activeElement?.id)).toBe('universe-map-toggle');
      await page.locator('#universe-map-toggle').click();
      await page.evaluate(() => window.gameController?.gameOver('boundary'));
      await expect
        .poll(() => page.evaluate(() => document.activeElement?.id), { timeout: 5000 })
        .toBe('playerNameInput');
      expect(await page.locator('#universe-map-dialog').isVisible()).toBe(false);
    }

    assertNoBrowserDiagnostics(diagnostics);
  },
  TestConfig.DEFAULT_TIMEOUT * 2
);
