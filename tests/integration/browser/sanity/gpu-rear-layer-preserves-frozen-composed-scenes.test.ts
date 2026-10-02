// @vitest-environment node
import { writeFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { createClientConsoleDiagnostics } from '../../../../benchmarks/client-console-diagnostics';
import {
  type createFrozenGpuScene,
  FROZEN_GPU_CHECKPOINTS,
} from '../../../support/gpu-composed-scene';
import { disableViteClientTransport } from '../../../support/native-lifecycle-browser';
import {
  assertNoBrowserDiagnostics,
  watchBrowserDiagnostics,
} from '../../utils/browser-diagnostics';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { TestConfig } from '../../utils/test-config';

const { browserManager, screenshotManager } = createBrowserScenarioHooks(__dirname);
type FrozenScene = Awaited<ReturnType<typeof createFrozenGpuScene>>;
const VIEWPORTS = [
  { name: 'desktop-dpr1', width: 1920, height: 1080, dpr: 1, touch: false },
  { name: 'desktop-dpr2', width: 1920, height: 1080, dpr: 2, touch: false },
  { name: 'touch-portrait-dpr3', width: 390, height: 844, dpr: 3, touch: true },
  { name: 'touch-landscape-dpr3', width: 844, height: 390, dpr: 3, touch: true },
  { name: 'tablet-dpr2', width: 1024, height: 768, dpr: 2, touch: true },
  { name: 'fractional-backing-edge', width: 139, height: 101, dpr: 1.25, touch: false },
];

for (const viewport of VIEWPORTS) {
  test(`GPU rear layers preserve frozen composed scenes on ${viewport.name}`, async () => {
    const page = await browserManager.recreatePage({ hasTouch: viewport.touch });
    const session = await page.context().newCDPSession(page);
    const diagnostics = watchBrowserDiagnostics(page);
    await session.send('Emulation.setDeviceMetricsOverride', {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: viewport.dpr,
      mobile: viewport.touch,
    });
    let viteClientResponses = 0;
    let viteClientFailure: unknown;
    const sockets: string[] = [];
    page.on('websocket', (socket) => sockets.push(socket.url()));
    await page.route(
      (url) => url.pathname === '/@vite/client',
      async (route) => {
        try {
          const response = await route.fetch({ timeout: 5000, maxRedirects: 0 });
          if (response.status() !== 200) {
            throw new Error('Pinned Vite client bootstrap fetch failed');
          }
          const transformed = disableViteClientTransport(await response.text());
          await route.fulfill({ response, body: transformed.body });
          viteClientResponses++;
        } catch (error) {
          viteClientFailure = error;
          await route.abort('failed');
        }
      }
    );
    await page.route('**/__gpu-frozen.html*', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"></head><body></body></html>',
      })
    );
    await page.goto(`${TestConfig.GAME_URL}/__gpu-frozen.html?renderer=webgl2`);
    const fixture = await page.evaluateHandle<FrozenScene>(
      "import('/tests/support/gpu-composed-scene.ts').then(module => module.createFrozenGpuScene())"
    );
    const failures: string[] = [];
    let finalCompletedReadbacks = 0;
    const observationDiagnostics = (completedReadbacks: number) => {
      // Each successful pixel read is an owned observation capture. It admits
      // at most one exact Chromium warning of each known readback type.
      const recorder = createClientConsoleDiagnostics('observation', completedReadbacks);
      for (const message of diagnostics.warnings) {
        recorder.warning(message);
      }
      return recorder.finish(completedReadbacks);
    };
    try {
      for (const checkpoint of FROZEN_GPU_CHECKPOINTS) {
        const result = await fixture.evaluate((scene, name) => scene.capture(name), checkpoint);
        const prefix = `frozen-${viewport.name}-${checkpoint}`;
        const paths: Record<string, string> = {};
        for (const [name, data] of Object.entries(result.images)) {
          if (!data.startsWith('data:image/png;base64,')) {
            throw new Error(`Invalid ${name} diagnostic image`);
          }
          const path = screenshotManager.getScreenshotPath(
            screenshotManager.getTimestampedFilename(`${prefix}-${name}`)
          );
          writeFileSync(path, Buffer.from(data.slice('data:image/png;base64,'.length), 'base64'));
          paths[name] = path;
        }
        const { images: _images, ...observations } = result;
        const completedReadbacks = await fixture.evaluate((scene) => scene.getCompletedReadbacks());
        const ownedConsole = observationDiagnostics(completedReadbacks);
        writeFileSync(
          screenshotManager.getScreenshotPath(
            screenshotManager.getTimestampedFilename(prefix).replace(/\.png$/u, '.json')
          ),
          JSON.stringify(
            {
              ...observations,
              viewport,
              images: paths,
              browserVersion: page.context().browser()?.version(),
              observationDiagnostics: ownedConsole,
            },
            null,
            2
          )
        );
        if (['stationary', 'scan-easing', 'scan-wide', 'scan-return-easing'].includes(checkpoint)) {
          for (const recovery of [result.blitFailure, result.drawFailure]) {
            expect(recovery).toMatchObject({
              backend: 'canvas',
              injectedFailures: 1,
              differingChannels: 0,
              stats: {
                state: 'failed',
                drawCalls: 0,
                geometryUploads: 0,
                uploadedBytes: 0,
                submittedStars: 0,
                submittedSegments: 0,
                contourMode: 'none',
                contourReason: 'none',
                nativeContourSegments: 0,
                rearBlits: 0,
                totalRearBlits: 0,
              },
            });
          }
        }
        if (checkpoint === 'stationary') {
          const background = await fixture.evaluate((scene) => scene.probeBackground());
          expect(background.changedInnerPixels).toBe(0);
          expect(background.frames).toHaveLength(2);
          for (const frame of background.frames) {
            expect(frame).toEqual({ stalePixels: 0, restoredTransform: true, restoredStyle: true });
          }
          if (viewport.name === 'fractional-backing-edge') {
            expect(background.changedPadding).toBeGreaterThan(0);
          } else {
            expect(background.changedPadding).toBe(0);
          }
          const quantization = await fixture.evaluate((scene) => scene.probeQuantization());
          writeFileSync(
            screenshotManager.getScreenshotPath(
              screenshotManager
                .getTimestampedFilename(`quantization-${viewport.name}`)
                .replace(/\.png$/u, '.json')
            ),
            JSON.stringify(quantization, null, 2)
          );
          if (
            quantization.lowCoveragePixelDifferences !== 0 ||
            quantization.zeroSourceWitnesses === 0 ||
            quantization.distinctDestinations < 3 ||
            quantization.lowCoverage.some((pixel) => pixel.coverageCanvas !== pixel.coverageWebgl2)
          ) {
            failures.push(`Low-coverage probe: ${JSON.stringify(quantization)}`);
          }
          for (const color of [
            ...quantization.stars,
            ...quantization.overlappingStars,
            ...quantization.contours,
            ...quantization.lowCoverage,
          ]) {
            if (color.canvas.some((channel, index) => channel !== color.webgl2[index])) {
              failures.push(
                `Byte-color probe alpha=${color.alpha}: Canvas=${color.canvas.join(',')}, GPU=${color.webgl2.join(',')}`
              );
            }
          }
        }
        expect(result.renderer).toBe('webgl2');
        expect(result.canvasRenderer).toBe('canvas');
        expect(result.stats?.state).toBe('ready');
        expect(result.stats?.workload).toBe('native-rear-gpu-contours');
        expect(result.stats?.submittedStars).toBe(0);
        expect(result.stats?.nativeStars).toBeGreaterThan(0);
        expect(result.stats?.nativeStarRects).toBeLessThanOrEqual(result.stats?.nativeStars ?? 0);
        expect(result.stats?.rearTextureUploads).toBe(1);
        expect(result.stats?.rearTextureUploadBytes).toBe(result.width * result.height * 4);
        expect(result.contourGeometryMatches).toBe(true);
        expect(result.stats?.rearBlits).toBe(1);
        if (result.stats?.contourMode === 'canvas-path') {
          expect(result.stats.drawCalls).toBe(1);
          expect(result.stats.geometryUploads).toBe(0);
          expect(result.stats.uploadedBytes).toBe(0);
          expect(['hairline', 'rotated-path-coverage']).toContain(result.stats.contourReason);
          if (result.stats.contourReason === 'rotated-path-coverage') {
            expect(result.rotation).not.toBe(0);
          }
          expect(result.stats.submittedSegments).toBe(0);
          expect(result.stats.nativeContourSegments).toBe(result.segments);
        } else {
          expect(result.stats?.contourMode).toBe('gpu-capsules');
          expect(result.stats?.contourReason).toBe('none');
          expect(result.rotation).toBe(0);
          expect(result.stats?.submittedSegments).toBe(result.segments);
          expect(result.stats?.nativeContourSegments).toBe(0);
        }
        expect(result.width).toBe(Math.round(viewport.width * viewport.dpr));
        expect(result.height).toBe(Math.round(viewport.height * viewport.dpr));
        expect(result.dpr).toBe(viewport.dpr);
        expect(result.cssWidth).toBe(viewport.width);
        expect(result.cssHeight).toBe(viewport.height);
        expect(result.rotation).toBeCloseTo(
          checkpoint.endsWith('45') ? Math.PI / 4 : checkpoint.endsWith('90') ? Math.PI / 2 : 0,
          10
        );
        if (checkpoint === 'scan-wide' || checkpoint.startsWith('star-edges-scan')) {
          expect(result.zoom).toBeLessThan(1);
        }
        expect(result.pilots).toEqual(['frozen-local', 'frozen-remote']);
        expect(result.asteroidCount).toBe(24);
        expect(result.frozenLaserCount).toBe(2);
        expect(result.spiderCount).toBe(1);
        if (checkpoint === 'lit-furnace-combat') {
          expect(result.furnacePixels.canvas).toBeGreaterThan(0);
          expect(result.furnacePixels.webgl2).toBeGreaterThan(0);
        }
        if (
          result.outsideDifferences !== 0 ||
          result.starCoverageDifferences !== 0 ||
          result.rear.outsideDifferences !== 0 ||
          result.rear.interiorDifferences !== 0 ||
          result.interiorDifferences !== 0 ||
          (result.supplemental &&
            (result.supplemental.outsideDifferences !== 0 ||
              result.supplemental.interiorDifferences !== 0)) ||
          result.witnesses.brightnessDifferences !== 0 ||
          !result.witnesses.capPresent ||
          !result.witnesses.buttCapsRejected ||
          !result.witnesses.nativeHairlineCapsRejected ||
          !result.witnesses.missingRejected ||
          !result.witnesses.doubledRejected
        ) {
          failures.push(
            `${checkpoint}: outside=${result.outsideDifferences}, interiors=${result.interiorDifferences}, supplemental=${JSON.stringify(result.supplemental && { outside: result.supplemental.outsideDifferences, interiors: result.supplemental.interiorDifferences })}, witnesses=${JSON.stringify(result.witnesses)}`
          );
        }
      }
      // Keep all matrix artifacts even when the first checkpoint has a mismatch.
      expect(failures).toEqual([]);
      observationDiagnostics(await fixture.evaluate((scene) => scene.getCompletedReadbacks()));
      assertNoBrowserDiagnostics({ errors: diagnostics.errors, warnings: [] });
      expect(viteClientFailure).toBeUndefined();
      expect(viteClientResponses).toBe(1);
      expect(sockets).toEqual([]);
    } finally {
      finalCompletedReadbacks = await fixture.evaluate((scene) => {
        const completed = scene.getCompletedReadbacks();
        scene.finish();
        return completed;
      });
      await fixture.dispose();
      await session.detach();
      await page.close();
    }
    const finalDiagnostics = observationDiagnostics(finalCompletedReadbacks);
    writeFileSync(
      screenshotManager.getScreenshotPath(
        screenshotManager
          .getTimestampedFilename(`frozen-${viewport.name}-observation-diagnostics`)
          .replace(/\.png$/u, '.json')
      ),
      JSON.stringify(finalDiagnostics, null, 2)
    );
    assertNoBrowserDiagnostics({ errors: diagnostics.errors, warnings: [] });
  });
}
