import { expect, test } from 'vitest';
import {
  assertNoBrowserDiagnostics,
  watchBrowserDiagnostics,
} from '../../utils/browser-diagnostics';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';
import { arrangeCrewField } from '../../utils/test-server-control';
import { centerOf, dispatchTouch } from '../../utils/touch-input';

const { browserManager, screenshotManager } = createBrowserScenarioHooks(__dirname);

// Isolate the real terrain painter on black to inspect its pixels independently
// of colored ships, webs, and the blue-black gameplay background. Restore the
// actual game frame synchronously; the running simulation remains untouched.
const readTerrainPixels = `(async () => {
  const { drawIsoContours } = await import('/src/rendering/contourRenderer.ts');
  const { canvasManager } = await import('/src/rendering/canvasSurface.ts');
  const canvas = canvasManager.getCanvas();
  const ctx = canvasManager.getContext();
  const viewport = canvasManager.getViewportSize();
  if (!canvas || !ctx) throw new Error('Missing gameplay canvas');
  const saved = document.createElement('canvas');
  saved.width = canvas.width;
  saved.height = canvas.height;
  saved.getContext('2d').drawImage(canvas, 0, 0);
  const readback = document.createElement('canvas');
  readback.width = canvas.width;
  readback.height = canvas.height;
  const readCtx = readback.getContext('2d', {willReadFrequently: true});
  try {
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, viewport.width, viewport.height);
    drawIsoContours({x: -2100, y: 700});
    readCtx.drawImage(canvas, 0, 0);
    const pixels = readCtx.getImageData(0, 0, canvas.width, canvas.height).data;
    let lit = 0;
    let chromatic = 0;
    let brightest = 0;
    let checksum = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      const [r, g, b] = [pixels[i], pixels[i + 1], pixels[i + 2]];
      if (r || g || b) lit++;
      if (r !== g || g !== b) chromatic++;
      brightest = Math.max(brightest, r, g, b);
      checksum = (Math.imul(checksum, 31) + r * 3 + g * 5 + b * 7) >>> 0;
    }
    return {lit, chromatic, brightest, checksum, rotation: canvasManager.getCameraRotation()};
  } finally {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(saved, 0, 0);
    ctx.restore();
  }
})()`;

type TerrainPixels = {
  lit: number;
  chromatic: number;
  brightest: number;
  checksum: number;
  rotation: number;
};

for (const viewport of [
  { name: 'desktop', width: 1280, height: 900, hasTouch: false },
  { name: 'mobile', width: 390, height: 844, hasTouch: true },
]) {
  test(`contours stay neutral while a ${viewport.name} pilot turns and requests reduced motion`, async () => {
    const page = await browserManager.recreatePage({ hasTouch: viewport.hasTouch });
    await page.setViewportSize(viewport);
    const diagnostics = watchBrowserDiagnostics(page);
    const game = new GameInteractions(page);
    await game.bootGame({ waitForCombatReady: false });
    await arrangeCrewField([await game.getLocalPlayerId()], 'empty');
    await game.placeShipAt(-2100, 700);
    await game.armSpawnProtection();
    const camera = await page.evaluateHandle<
      typeof import('../../../../src/rendering/canvasSurface').canvasManager
    >("import('/src/rendering/canvasSurface.ts').then(module => module.canvasManager)");
    // Placement stops velocity; the travel camera holds its previous course
    // until movement resumes. Establish the actual moving view before comparing.
    await expect
      .poll(
        () =>
          camera.evaluate((surface) => {
            const ship = window.gameController?.getCurrPlayer()?.ship;
            if (!ship) {
              throw new Error('Missing pilot while establishing the camera baseline');
            }
            const course = Math.atan2(-ship.velocity.y, ship.velocity.x);
            const distance = (a: number, b: number) =>
              Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
            return (
              Math.hypot(ship.velocity.x, ship.velocity.y) > 0.01 &&
              distance(course, ship.angle) < 0.01 &&
              distance(surface.getCameraRotation(), course - Math.PI / 2) < 0.01
            );
          }),
        { timeout: 5000 }
      )
      .toBe(true);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    const before = await page.evaluate<TerrainPixels>(readTerrainPixels);
    expect(before.lit).toBeGreaterThan(500);
    expect(before.chromatic).toBe(0);
    expect(before.brightest).toBeGreaterThan(20);
    expect(before.brightest).toBeLessThanOrEqual(104);
    const start = await page.evaluate(() => {
      const ship = window.gameController?.getCurrPlayer()?.ship;
      if (!ship) {
        throw new Error('Local ship unavailable');
      }
      return { position: { ...ship.position }, angle: ship.angle };
    });
    const center = await centerOf(page, '#gameCanvas');
    const point = {
      x: center.x + 100,
      y: center.y,
      id: 1,
    };
    const session = viewport.hasTouch ? await page.context().newCDPSession(page) : null;
    let touchActive = false;
    try {
      if (session) {
        await dispatchTouch(session, 'touchStart', [point]);
        touchActive = true;
      } else {
        await page.mouse.move(point.x, point.y);
      }
      await page.waitForFunction((heading) => {
        const ship = window.gameController?.getCurrPlayer()?.ship;
        return (
          ship &&
          Math.abs(Math.atan2(Math.sin(ship.angle - heading), Math.cos(ship.angle - heading))) > 1
        );
      }, start.angle);
      // Nose movement alone does not prove the renderer has followed the new
      // travel course. Observe the rendered camera before releasing steering.
      await expect
        .poll(
          () =>
            camera.evaluate((surface, initialRotation) => {
              const delta = surface.getCameraRotation() - initialRotation;
              return Math.abs(Math.atan2(Math.sin(delta), Math.cos(delta)));
            }, before.rotation),
          { timeout: 5000 }
        )
        .toBeGreaterThan(1);
      if (session) {
        await dispatchTouch(session, 'touchEnd', []);
        touchActive = false;
      } else {
        await page.mouse.move(center.x, center.y);
      }
      await page.waitForFunction((position) => {
        const ship = window.gameController?.getCurrPlayer()?.ship;
        return ship && Math.hypot(ship.position.x - position.x, ship.position.y - position.y) > 20;
      }, start.position);
      const turned = await page.evaluate<TerrainPixels>(readTerrainPixels);
      expect(turned.lit).toBeGreaterThan(500);
      expect(turned.chromatic).toBe(0);
      expect(turned.brightest).toBeGreaterThan(20);
      expect(turned.brightest).toBeLessThanOrEqual(104);
      expect(turned.checksum).not.toBe(before.checksum);
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.waitForFunction(() => matchMedia('(prefers-reduced-motion: reduce)').matches);
      const reduced = await page.evaluate<TerrainPixels>(readTerrainPixels);
      expect(reduced.lit).toBeGreaterThan(500);
      expect(reduced.chromatic).toBe(0);
      expect(reduced.brightest).toBeGreaterThan(20);
      expect(reduced.brightest).toBeLessThanOrEqual(104);
      await page.screenshot({
        path: screenshotManager.getScreenshotPath(`neutral-contours-${viewport.name}.png`),
      });
      assertNoBrowserDiagnostics(diagnostics);
    } finally {
      await camera.dispose();
      if (session) {
        if (touchActive) {
          await dispatchTouch(session, 'touchEnd', []);
        }
        await session.detach();
      }
    }
  });
}
