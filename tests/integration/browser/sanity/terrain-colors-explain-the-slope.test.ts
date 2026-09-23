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
  const frames = [0, 1].map(() => {
    ctx.fillStyle = PALETTE.BG;
    ctx.fillRect(0, 0, viewport.width, viewport.height);
    drawIsoContours({x: -2100, y: 700}, 0);
    readCtx.drawImage(canvas, 0, 0);
    return readCtx.getImageData(0, 0, canvas.width, canvas.height).data;
  });
  let changes = 0;
  let warm = 0;
  let cool = 0;
  for (let i = 0; i < frames[0].length; i += 4) {
    if (frames[0][i] !== frames[1][i] || frames[0][i+1] !== frames[1][i+1] || frames[0][i+2] !== frames[1][i+2]) changes++;
    if (frames[0][i] > frames[0][i+2] + 50) warm++;
    if (frames[0][i+2] > frames[0][i] + 50 && frames[0][i+2] > 45) cool++;
  }
  let behindColor = 0;
  let violetBehind = 0;
  for (let y = 0; y < canvas.height; y++) {
    for (let x = 0; x < canvas.width / 2; x++) {
      const i = (y * canvas.width + x) * 4;
      // Violet passage markers are omnidirectional; only slope colors belong in the cone.
      const warmSlope = frames[0][i] > frames[0][i+2] + 50;
      const coolSlope = frames[0][i+2] > frames[0][i] + 50 && frames[0][i+1] > frames[0][i] + 10;
      if (warmSlope || coolSlope) behindColor++;
      if (frames[0][i+2] > frames[0][i] + 25 && frames[0][i] > frames[0][i+1] + 12) violetBehind++;
    }
  }
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(saved, 0, 0);
  ctx.restore();
  return {changes, warm, cool, behindColor, violetBehind};
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
      warm: number;
      cool: number;
      behindColor: number;
      violetBehind: number;
    }>(compareTerrainFrames);
    expect(moving.changes).toBe(0);
    expect(moving.warm).toBeGreaterThan(50);
    expect(moving.behindColor).toBe(0);
    expect(moving.violetBehind).toBeGreaterThan(50);
    await page.screenshot({ path: `/tmp/georoids-color-terrain-${viewport.name}.png` });

    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.waitForFunction(() => matchMedia('(prefers-reduced-motion: reduce)').matches);
    const still = await page.evaluate<{
      changes: number;
      warm: number;
      cool: number;
      behindColor: number;
      violetBehind: number;
    }>(compareTerrainFrames);
    expect(still.changes).toBe(0);
    expect(still.warm).toBe(moving.warm);
    expect(still.cool).toBe(moving.cool);
    expect(still.behindColor).toBe(moving.behindColor);
    expect(still.violetBehind).toBe(moving.violetBehind);
    expect(problems).toEqual([]);
  });
}
