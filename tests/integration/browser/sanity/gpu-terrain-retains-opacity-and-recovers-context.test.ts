// @vitest-environment node
import { expect, test } from 'vitest';
import {
  assertNoBrowserDiagnostics,
  watchBrowserDiagnostics,
} from '../../utils/browser-diagnostics';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { TestConfig } from '../../utils/test-config';

const { browserManager } = createBrowserScenarioHooks(__dirname);
type Surface = typeof import('../../../../src/rendering/canvasSurface').canvasManager;

test('GPU terrain retains local buffers and union opacity through repeated context recovery', async () => {
  const page = await browserManager.recreatePage({ hasTouch: true });
  await page.setViewportSize({ width: 120, height: 100 });
  const diagnostics = watchBrowserDiagnostics(page);
  await page.goto(`${TestConfig.GAME_URL}?renderer=webgl2`);
  const surface = await page.evaluateHandle<Surface>(
    "import('/src/rendering/canvasSurface.ts').then(module => module.canvasManager)"
  );
  try {
    await surface.evaluate((canvas) => canvas.initialize());
    const observations = await surface.evaluate((canvas) => {
      const gpu = document.querySelector('#gameGpuCanvas');
      if (!(gpu instanceof HTMLCanvasElement)) {
        throw new Error('GPU rear layer was unavailable');
      }
      const snapshot = document.createElement('canvas');
      snapshot.width = gpu.width;
      snapshot.height = gpu.height;
      const read = snapshot.getContext('2d', { willReadFrequently: true });
      if (!read) {
        throw new Error('Pixel observation canvas was unavailable');
      }
      const segment = { ax: -20, ay: 0, bx: 20, by: 0 };
      const contours = [{ index: 1, segments: [segment] }];
      const scene = { position: { x: 0, y: 0 }, starTiles: [], contours };
      const capture = () => {
        if (!canvas.drawGpuRear(scene)) {
          throw new Error('GPU drawing failed');
        }
        if (canvas.getRendererBackend() !== 'canvas') {
          throw new Error('GPU backend became active before composition');
        }
        if (!canvas.composeGpuRear(canvas.requireContext())) {
          throw new Error('GPU rear composition failed');
        }
        snapshot.width = gpu.width;
        snapshot.height = gpu.height;
        read.drawImage(gpu, 0, 0);
        return Array.from(read.getImageData(0, 0, snapshot.width, snapshot.height).data);
      };
      const first = capture();
      const firstStats = canvas.getGpuFrameStats();
      const warm = capture();
      const warmStats = canvas.getGpuFrameStats();
      // Membership is immutable in production; replacement identity publishes a new batch.
      scene.contours = [{ index: 1, segments: [segment, segment] }];
      const duplicated = capture();
      scene.contours = [{ index: 1, segments: [segment, { ax: 0, ay: -20, bx: 0, by: 20 }] }];
      const crossing = capture();
      const crossingStats = canvas.getGpuFrameStats();
      let brightest = 0;
      let lit = 0;
      for (let index = 0; index < crossing.length; index += 4) {
        const red = crossing[index] ?? 0;
        brightest = Math.max(brightest, red);
        if (red > 0) {
          lit++;
        }
      }
      return {
        first,
        warm,
        duplicated,
        brightest,
        lit,
        firstStats,
        warmStats,
        crossingStats,
        overlayAlpha: canvas.requireContext().getContextAttributes().alpha,
        backend: canvas.getRendererBackend(),
        width: gpu.width,
        height: gpu.height,
      };
    });
    expect(observations.backend).toBe('webgl2');
    expect(observations.overlayAlpha).toBe(false);
    expect(observations.width).toBe(240);
    expect(observations.height).toBe(200);
    expect(observations.lit).toBeGreaterThan(100);
    expect(observations.brightest).toBeGreaterThan(20);
    expect(observations.brightest).toBeLessThanOrEqual(30);
    expect(observations.warm).toEqual(observations.first);
    expect(observations.duplicated).toEqual(observations.first);
    expect(observations.firstStats?.geometryUploads).toBe(1);
    expect(observations.warmStats?.geometryUploads).toBe(0);
    expect(observations.crossingStats?.retainedBuffers).toBe(1);
    expect(observations.crossingStats?.submittedSegments).toBe(2);

    const extension = await page.evaluateHandle(() => {
      const gpu = document.querySelector('#gameGpuCanvas');
      if (!(gpu instanceof HTMLCanvasElement)) {
        throw new Error('Missing GPU canvas');
      }
      const contextControl = gpu.getContext('webgl2')?.getExtension('WEBGL_lose_context');
      if (!contextControl) {
        throw new Error('Context-loss control unavailable');
      }
      return contextControl;
    });
    try {
      for (let attempt = 1; attempt <= 2; attempt++) {
        await extension.evaluate((control) => control.loseContext());
        await expect
          .poll(() => surface.evaluate((canvas) => canvas.getGpuFrameStats()?.state))
          .toBe('context-lost');
        const fallback = await surface.evaluate((canvas) => {
          canvas.clearPlayfield();
          const sample = document.createElement('canvas');
          sample.width = 1;
          sample.height = 1;
          const read = sample.getContext('2d', { willReadFrequently: true });
          if (!read) {
            throw new Error('Missing fallback pixel reader');
          }
          read.drawImage(canvas.requireCanvas(), 0, 0);
          return {
            backend: canvas.getRendererBackend(),
            pixel: Array.from(read.getImageData(0, 0, 1, 1).data),
            stats: canvas.getGpuFrameStats(),
          };
        });
        expect(fallback.backend).toBe('canvas');
        expect(fallback.pixel).toEqual([0, 0, 17, 255]);
        expect(fallback.stats).toMatchObject({
          drawCalls: 0,
          geometryUploads: 0,
          uploadedBytes: 0,
          submittedStars: 0,
          submittedSegments: 0,
          contourMode: 'none',
          contourReason: 'none',
          nativeContourSegments: 0,
          rearBlits: 0,
        });
        expect(fallback.stats?.totalDrawCalls).toBeGreaterThan(0);
        expect(fallback.stats?.totalRearBlits).toBeGreaterThan(0);
        await extension.evaluate((control) => control.restoreContext());
        await expect
          .poll(() => surface.evaluate((canvas) => canvas.getGpuFrameStats()?.state))
          .toBe('ready');
        const recovered = await surface.evaluate((canvas) => {
          if (
            !canvas.drawGpuRear({
              position: { x: 0, y: 0 },
              starTiles: [],
              contours: [{ index: 1, segments: [{ ax: -20, ay: 0, bx: 20, by: 0 }] }],
            })
          ) {
            throw new Error('Restored context did not draw');
          }
          if (!canvas.composeGpuRear(canvas.requireContext())) {
            throw new Error('Restored context did not compose');
          }
          return { backend: canvas.getRendererBackend(), stats: canvas.getGpuFrameStats() };
        });
        expect(recovered.backend).toBe('webgl2');
        expect(recovered.stats?.contextLosses).toBe(attempt);
        expect(recovered.stats?.contextRestorations).toBe(attempt);
        expect(recovered.stats?.geometryUploads).toBe(1);
        expect(recovered.stats?.retainedBuffers).toBe(1);
      }
    } finally {
      await extension.dispose();
    }
    await surface.evaluate((canvas) => canvas.initialize());
    expect(await page.locator('#gameGpuCanvas').count()).toBe(1);
    await surface.evaluate((canvas) => canvas.destroy());
    expect(await page.locator('#gameGpuCanvas').count()).toBe(0);
    // Copying WebGL pixels into the observation canvas deliberately synchronizes
    // the GPU. Chromium's driver reports that readback cost in this pixel fixture.
    // Production gameplay is checked separately without any pixel readback.
    const observationWarning =
      /^\[\.WebGL-0x[0-9a-f]+\]GL Driver Message \(OpenGL, Performance, GL_CLOSE_PATH_NV, High\): GPU stall due to ReadPixels(?: \(this message will no longer repeat\))?$/iu;
    expect(
      diagnostics.warnings.filter((warning) => observationWarning.test(warning)).length
    ).toBeLessThanOrEqual(4);
    assertNoBrowserDiagnostics({
      errors: diagnostics.errors,
      warnings: diagnostics.warnings.filter((warning) => !observationWarning.test(warning)),
    });
  } finally {
    await surface.evaluate((canvas) => canvas.destroy());
    await surface.dispose();
  }
});

test('an unavailable GPU context keeps an opaque Canvas playfield without an extra canvas', async () => {
  const page = browserManager.getCurrentPage();
  if (!page) {
    throw new Error('Missing browser scenario page');
  }
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
      configurable: true,
      value(this: HTMLCanvasElement, type: string, options: unknown) {
        return type === 'webgl2' ? null : Reflect.apply(original, this, [type, options]);
      },
    });
  });
  const diagnostics = watchBrowserDiagnostics(page);
  await page.goto(`${TestConfig.GAME_URL}?renderer=webgl2`);
  const surface = await page.evaluateHandle<Surface>(
    "import('/src/rendering/canvasSurface.ts').then(module => module.canvasManager)"
  );
  try {
    const fallback = await surface.evaluate((canvas) => {
      canvas.initialize();
      canvas.clearPlayfield();
      return {
        backend: canvas.getRendererBackend(),
        available: canvas.canDrawGpuRear(),
        stats: canvas.getGpuFrameStats(),
        pixel: Array.from(canvas.requireContext().getImageData(0, 0, 1, 1).data),
      };
    });
    expect(fallback.backend).toBe('canvas');
    expect(fallback.available).toBe(false);
    expect(fallback.stats).toBe(null);
    expect(fallback.pixel).toEqual([0, 0, 17, 255]);
    expect(await page.locator('#gameGpuCanvas').count()).toBe(0);
    assertNoBrowserDiagnostics(diagnostics);
  } finally {
    await surface.evaluate((canvas) => canvas.destroy());
    await surface.dispose();
  }
});
