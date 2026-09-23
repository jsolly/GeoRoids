import { expect, test } from 'vitest';
import { civicLot } from '../../../../shared/furnaces';
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
  const furnace = civicLot('street-2-0');
  if (!furnace) {
    throw new Error('Universe map fixture requires an outer furnace foundation');
  }
  return furnace;
})();

function formatMapCoordinate(value: number): string {
  return `${value >= 0 ? '+' : ''}${Math.round(value)}`;
}

const FAR_FURNACE_LOCATION = `X ${formatMapCoordinate(FAR_FURNACE.position.x)}, Y ${formatMapCoordinate(FAR_FURNACE.position.y)}`;

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
      message: 'the universe map should render its nearby view',
    })
    .toSatisfy((mapFrame: MapFrame) => mapFrame.open && mapFrame.labels.includes('5k across'));
  const frame = await readMapFrame(page);
  expect(frame.canvas.width).toBeGreaterThan(0);
  expect(frame.canvas.height).toBeGreaterThan(0);
  expect(frame.status).toMatch(REVEALED_ASSETS_STATUS_PATTERN);
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
    await game.bootGame({ kitId: 'scout', waitForCombatReady: false });
    const playerId = await game.getLocalPlayerId();
    await arrangeCrewField([playerId], 'empty');
    await game.placeShipAt(FAR_FURNACE.position.x, FAR_FURNACE.position.y);

    // Passive Scout exploration reveals the regional cell. The marker must
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
    expect(frame.labels).toContain('5k across');
    expect(await page.locator('#universe-map-zoom').count()).toBe(0);
    expect(await page.locator('.universe-map-stage .universe-map-zoom').isVisible()).toBe(true);
    expect(await page.locator('.universe-map-actions #universe-map-zoom-in').count()).toBe(0);
    const locate = page.locator('#universe-map-center');
    expect(await locate.getAttribute('aria-label')).toBe('Center on you');
    expect(await page.locator('.universe-map-stage #universe-map-center').isVisible()).toBe(true);
    expect(await page.locator('.universe-map-actions #universe-map-center').count()).toBe(0);
    expect(await page.locator('#universe-map-close').getAttribute('aria-label')).toBe('Close');
    expect(await page.locator('#universe-map-close kbd').isVisible()).toBe(!touch);
    expect(await page.locator('#universe-map-toggle kbd').isVisible()).toBe(!touch);
    if (touch) {
      expect(await page.locator('.universe-map-help').textContent()).not.toMatch(/Esc|Home/u);
    } else {
      expect(await page.locator('.universe-map-help').textContent()).toMatch(/Esc/u);
    }
    const locations = page.getByRole('list', { name: 'Revealed landmarks and crew coordinates' });
    await expect.poll(() => locations.textContent(), { timeout: 5000 }).toContain(FAR_FURNACE.name);
    expect(await locations.textContent()).toContain(FAR_FURNACE_LOCATION);
    await page.screenshot({
      path: screenshotManager.getScreenshotPath(
        `crew-universe-map-${touch ? 'mobile' : 'desktop'}.png`
      ),
    });
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
        .poll(async () => (await readMapFrame(page)).labels.includes('5k across') === false, {
          timeout: 5000,
        })
        .toBe(true);
      expect(await locate.getAttribute('aria-pressed')).toBe('false');
    }
    const zoomOut = page.locator('#universe-map-zoom-out');
    for (let index = 0; index < 12; index++) {
      if (touch) {
        await zoomOut.tap();
      } else {
        await zoomOut.click();
      }
    }
    const wholeWorld = await readMapFrame(page);
    expect(wholeWorld.labels).toContain('120k across');
    expect(wholeWorld.labels).toContain(FAR_FURNACE.name);
    await locate.click();
    expect((await readMapFrame(page)).labels).toContain('5k across');
    expect(await locate.getAttribute('aria-pressed')).toBe('true');

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
    await game.placeShipAt(FAR_FURNACE.position.x, FAR_FURNACE.position.y);
    await page.locator('#universe-map-toggle').click();
    await expect
      .poll(() => page.locator('#universe-map-status').textContent())
      .toContain(`X ${formatMapCoordinate(FAR_FURNACE.position.x)}`);
    expect((await readMapFrame(page)).labels).toContain('5k across');
    await page.locator('#universe-map-close').click();
    if (!touch) {
      expect(await page.evaluate(() => document.activeElement?.id)).toBe('universe-map-toggle');
    }

    assertNoBrowserDiagnostics(diagnostics);
  },
  TestConfig.DEFAULT_TIMEOUT * 2
);

test(
  'nearby crew names stay separate and edge labels do not clip the map',
  async () => {
    const page = browserManager.getCurrentPage();
    if (!page) {
      throw new Error('Missing map pilot');
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    const diagnostics = watchBrowserDiagnostics(page);
    const game = new GameInteractions(page);
    await game.bootGame({ kitId: 'scout', waitForCombatReady: false });
    const teammatePage = await browserManager.createAdditionalPage();
    const teammate = new GameInteractions(teammatePage);
    await teammate.bootGame({ kitId: 'hauler', waitForCombatReady: false });
    const teammateName = await teammatePage.evaluate(
      () => window.gameController?.getCurrPlayer()?.name
    );
    if (!teammateName) {
      throw new Error('Missing teammate name');
    }
    await arrangeCrewField(
      [await game.getLocalPlayerId(), await teammate.getLocalPlayerId()],
      'empty'
    );
    await teammatePage.keyboard.press('KeyM');
    await game.placeShipAt(0, 0);
    await teammate.placeShipAt(0, 0);
    await page.bringToFront();
    await page.keyboard.press('KeyM');
    await expect
      .poll(() => page.locator('#universe-map-locations').textContent())
      .toContain(teammateName);
    expect((await readMapFrame(page)).labels).not.toContain(teammateName);
    await teammate.placeShipAt(2450, 0);
    await expect
      .poll(() => page.locator('#universe-map-locations').textContent())
      .toContain('X +2450');
    expect((await readMapFrame(page)).labels).not.toContain(teammateName);
    assertNoBrowserDiagnostics(diagnostics);
  },
  TestConfig.DEFAULT_TIMEOUT * 2
);

function readMapStrokePaths(page: import('playwright').Page, canvasId: string) {
  return page.evaluate(async (id) => {
    const canvas = document.querySelector(`#${id}`);
    if (!(canvas instanceof HTMLCanvasElement)) {
      throw new Error(`Missing map canvas ${id}`);
    }
    const paths: { color: string; lines: number; moves: number; firstX: number }[] = [];
    const original = {
      beginPath: CanvasRenderingContext2D.prototype.beginPath,
      moveTo: CanvasRenderingContext2D.prototype.moveTo,
      lineTo: CanvasRenderingContext2D.prototype.lineTo,
      stroke: CanvasRenderingContext2D.prototype.stroke,
    };
    let lines = 0;
    let moves = 0;
    let firstX = 0;
    CanvasRenderingContext2D.prototype.beginPath = function (this: CanvasRenderingContext2D) {
      if (this.canvas === canvas) {
        lines = 0;
        moves = 0;
      }
      original.beginPath.call(this);
    };
    CanvasRenderingContext2D.prototype.moveTo = function (this: CanvasRenderingContext2D, x, y) {
      if (this.canvas === canvas) {
        if (moves === 0) {
          firstX = x;
        }
        moves++;
      }
      original.moveTo.call(this, x, y);
    };
    CanvasRenderingContext2D.prototype.lineTo = function (this: CanvasRenderingContext2D, x, y) {
      if (this.canvas === canvas) {
        lines++;
      }
      original.lineTo.call(this, x, y);
    };
    CanvasRenderingContext2D.prototype.stroke = function (this: CanvasRenderingContext2D) {
      if (this.canvas === canvas && typeof this.strokeStyle === 'string') {
        paths.push({ color: this.strokeStyle, lines, moves, firstX });
      }
      Reflect.apply(original.stroke, this, []);
    };
    try {
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });
    } finally {
      Object.assign(CanvasRenderingContext2D.prototype, original);
    }
    return paths;
  }, canvasId);
}

test.each([
  { width: 1280, height: 900, touch: false, label: 'desktop' },
  { width: 390, height: 844, touch: true, label: 'mobile' },
])(
  'the $label pilot sees a web at a guarded stationary deposit on both maps',
  async ({ width, height, touch, label }) => {
    const page = touch
      ? await browserManager.recreatePage({ hasTouch: true })
      : browserManager.getCurrentPage();
    if (!page) {
      throw new Error('Missing nest map pilot');
    }
    const diagnostics = watchBrowserDiagnostics(page);
    await page.setViewportSize({ width, height });
    const game = new GameInteractions(page);
    await game.bootGame({ kitId: 'scout', waitForCombatReady: false });
    await arrangeCrewField([await game.getLocalPlayerId()], 'map-icons');
    const field = await page.evaluateHandle<
      () => import('../../../../shared-types').SpiderFieldState
    >(
      "import('/src/physics/terrain/spiderSession.ts').then(({ getSpiderField }) => getSpiderField)"
    );
    try {
      await expect
        .poll(
          () =>
            field.evaluate((read) =>
              read().nests.some(
                (nest) =>
                  nest.resourceId === 'crew-fixture-spider-deposit' &&
                  nest.position.x === 5000 &&
                  nest.position.y === 5000
              )
            ),
          { timeout: 5000 }
        )
        .toBe(true);
    } finally {
      await field.dispose();
    }
    await page.keyboard.press('KeyM');
    await game.placeShipAt(4550, 5000);
    await expect
      .poll(
        async () =>
          (await readMapStrokePaths(page, 'gameCanvas')).some(
            (path) => path.color === '#f43f5e' && path.lines >= 8 && path.moves >= 8
          ),
        {
          timeout: 5000,
          message: 'the minimap draws web spokes for the guarded deposit',
        }
      )
      .toBe(true);
    const mineralColors = ['#a5f3fc', '#fde68a', '#fdba74'];
    const unscanned = await readMapStrokePaths(page, 'universe-map-canvas');
    expect(unscanned.filter((path) => mineralColors.includes(path.color))).toHaveLength(0);
    await page.locator('#universe-map-close').click();
    await game.placeShipAt(4150, 5000);
    await page.screenshot({
      path: screenshotManager.getScreenshotPath(`nest-minimap-unscanned-${label}.png`),
    });
    if (touch) {
      await page.locator('#touch-ability').tap();
    } else {
      await page.keyboard.press('KeyE');
    }
    await page.waitForFunction(
      () => (window.gameController?.getCurrPlayer()?.ship.abilityActiveFrames ?? 0) > 0
    );
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const rocks = window.gameController?.getCurrRoidBelt()?.getRoids() ?? [];
            return [
              'crew-fixture-spider-deposit',
              'crew-fixture-map-ice',
              'crew-fixture-map-rubble',
            ].map((id) => {
              const rock = rocks.find((candidate) => candidate.id === id);
              return { id, present: Boolean(rock), surveyed: (rock?.surveyedBy?.length ?? 0) > 0 };
            });
          }),
        { timeout: 5000 }
      )
      .toEqual([
        { id: 'crew-fixture-spider-deposit', present: true, surveyed: true },
        { id: 'crew-fixture-map-ice', present: true, surveyed: true },
        { id: 'crew-fixture-map-rubble', present: true, surveyed: true },
      ]);
    await expect
      .poll(
        async () => {
          const paths = await readMapStrokePaths(page, 'gameCanvas');
          return mineralColors.every((color) =>
            paths.some(
              (path) =>
                path.color === color &&
                path.lines >= 6 &&
                path.firstX > width - 120 &&
                path.firstX < width
            )
          );
        },
        { timeout: 5000, message: 'Scan classifies all three rock materials on the minimap' }
      )
      .toBe(true);
    await page.screenshot({
      path: screenshotManager.getScreenshotPath(`nest-minimap-${label}.png`),
    });
    await game.placeShipAt(3000, 5000);
    await page.waitForFunction(
      () => window.gameController?.getCurrPlayer()?.ship.abilityActiveFrames === 0,
      undefined,
      { timeout: 8000 }
    );
    await openAndCaptureMap(page, touch);
    await game.placeShipAt(4550, 5000);
    await page.locator('#universe-map-center').click();
    await expect
      .poll(
        async () => {
          const classified = await readMapStrokePaths(page, 'universe-map-canvas');
          return mineralColors.every((color) =>
            classified.some((path) => path.color === color && path.lines >= 6)
          );
        },
        {
          timeout: 5000,
          message: 'classified rocks retain their material details after Scan expires',
        }
      )
      .toBe(true);
    await expect
      .poll(
        async () =>
          (await readMapStrokePaths(page, 'universe-map-canvas')).some(
            (path) => path.color === '#f43f5e' && path.lines >= 8 && path.moves >= 8
          ),
        { timeout: 5000, message: 'the universe map draws the same nest web' }
      )
      .toBe(true);
    await page.screenshot({
      path: screenshotManager.getScreenshotPath(`nest-universe-map-${label}.png`),
    });
    const canvas = page.locator('#universe-map-canvas');
    const box = await canvas.boundingBox();
    if (!box) {
      throw new Error('Missing map bounds');
    }
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    try {
      await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2 + 30, { steps: 5 });
    } finally {
      await page.mouse.up();
    }
    expect(await page.locator('#universe-map-center').getAttribute('aria-pressed')).toBe('false');
    await page.locator('#universe-map-center').click();
    expect(await page.locator('#universe-map-center').getAttribute('aria-pressed')).toBe('true');
    await page.locator('#universe-map-close').click();
    expect(await page.locator('#universe-map-dialog').isVisible()).toBe(false);
    for (const article of ['hud-network', 'terrain']) {
      await page.goto(`${TestConfig.GAME_URL}/wiki/#${article}`);
      await page.locator('#content h1').waitFor({ state: 'visible' });
      await page
        .getByText(
          article === 'terrain' ? 'Red map webs' : 'Discovered furnaces appear as flames',
          { exact: false }
        )
        .scrollIntoViewIfNeeded();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true
      );
      await page.screenshot({
        path: screenshotManager.getScreenshotPath(`nest-wiki-${article}-${label}.png`),
      });
    }
    assertNoBrowserDiagnostics(diagnostics);
  },
  TestConfig.DEFAULT_TIMEOUT * 2
);
