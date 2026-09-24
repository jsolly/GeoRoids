import { expect, test } from 'vitest';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';

const { browserManager } = createBrowserScenarioHooks(__dirname);

// Exercise the real browser painter twice with a fixed terrain camera.
// Restore the gameplay frame before returning; no simulated actors are moved by this probe.
const compareTerrainFrames = `(async () => {
  const { drawIsoContours } = await import('/src/rendering/contourRenderer.ts');
  const { canvasManager } = await import('/src/rendering/canvasSurface.ts');
  const { PALETTE } = await import('/src/constants/index.ts');
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
  const rotation = canvasManager.getCameraRotation();
  try {
    canvasManager.followTravel({angle: Math.PI / 2, velocity: {x: 0, y: -1}});
    const frames = [0, 1].map(() => {
      ctx.fillStyle = PALETTE.BG;
      ctx.fillRect(0, 0, viewport.width, viewport.height);
      drawIsoContours({x: -2100, y: 700}, 0);
      readCtx.drawImage(canvas, 0, 0);
      return readCtx.getImageData(0, 0, canvas.width, canvas.height).data;
    });
    let changes = 0;
    let light = 0;
    let chromatic = 0;
    let lightBehind = 0;
    let checksum = 0;
    const isLightEnd = (r, g, b) => r >= 88 && g >= r - 2 && b > r && b - r < 40 && g < r + 22;
    const isOldHue = (r, g, b) => r > b + 40 || (b > r + 25 && r > g + 12);
    for (let i = 0; i < frames[0].length; i += 4) {
      const r = frames[0][i];
      const g = frames[0][i + 1];
      const b = frames[0][i + 2];
      if (r !== frames[1][i] || g !== frames[1][i + 1] || b !== frames[1][i + 2]) changes++;
      if (isLightEnd(r, g, b)) light++;
      if (isOldHue(r, g, b)) chromatic++;
      if (i % 16 === 0) checksum = (checksum + r * 3 + g * 5 + b * 7) >>> 0;
    }
    for (let y = 0; y < canvas.height; y++) {
      for (let x = 0; x < canvas.width / 2; x++) {
        const i = (y * canvas.width + x) * 4;
        // Shortcuts use the light end in every direction. Amber and violet are gone.
        if (isLightEnd(frames[0][i], frames[0][i + 1], frames[0][i + 2])) lightBehind++;
      }
    }
    return {changes, light, chromatic, lightBehind, checksum};
  } finally {
    canvasManager.followTravel({angle: rotation + Math.PI / 2, velocity: {x: 0, y: 0}});
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(saved, 0, 0);
    ctx.restore();
  }
})()`;

for (const viewport of [
  { name: 'desktop', width: 1280, height: 900, hasTouch: false },
  { name: 'mobile', width: 390, height: 844, hasTouch: true },
]) {
  test(`terrain colors stay visible when a ${viewport.name} pilot requests reduced motion`, async () => {
    const page = await browserManager.recreatePage({ hasTouch: viewport.hasTouch });
    await page.setViewportSize(viewport);
    const problems: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'warning' || message.type() === 'error') {
        problems.push(`${message.type()}: ${message.text()}`);
      }
    });
    page.on('pageerror', (error) => problems.push(error.message));
    const game = new GameInteractions(page);
    await game.bootGame({ waitForCombatReady: false });
    await game.placeShipAt(-2100, 700);
    await game.armSpawnProtection();
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    const moving = await page.evaluate<{
      changes: number;
      light: number;
      chromatic: number;
      lightBehind: number;
      checksum: number;
    }>(compareTerrainFrames);
    expect(moving.changes).toBe(0);
    expect(moving.light).toBeGreaterThan(50);
    expect(moving.chromatic).toBe(0);
    expect(moving.lightBehind).toBeGreaterThan(50);
    await page.screenshot({ path: `/tmp/georoids-color-terrain-${viewport.name}.png` });

    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.waitForFunction(() => matchMedia('(prefers-reduced-motion: reduce)').matches);
    const still = await page.evaluate<{
      changes: number;
      light: number;
      chromatic: number;
      lightBehind: number;
      checksum: number;
    }>(compareTerrainFrames);
    expect(still.changes).toBe(0);
    expect(still.light).toBe(moving.light);
    expect(still.chromatic).toBe(moving.chromatic);
    expect(still.lightBehind).toBe(moving.lightBehind);
    expect(still.checksum).toBe(moving.checksum);
    expect(problems).toEqual([]);
  });
}
