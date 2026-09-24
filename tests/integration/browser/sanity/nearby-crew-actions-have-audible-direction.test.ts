import assert from 'node:assert/strict';
import type { Page } from 'playwright';
import { expect, test } from 'vitest';
import { installAudioProbe } from '../../utils/audio-probe';
import {
  assertNoBrowserDiagnostics,
  watchBrowserDiagnostics,
} from '../../utils/browser-diagnostics';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';
import { TestConfig } from '../../utils/test-config';
import { arrangeCrewField } from '../../utils/test-server-control';

const { browserManager, screenshotManager } = createBrowserScenarioHooks(__dirname);

function positionsForSample(page: Page, name: string) {
  return page.evaluate(async (sampleName) => {
    const context = new OfflineAudioContext(2, 1, 48000);
    const response = await fetch(`/sounds/${sampleName}.m4a`);
    const sample = await context.decodeAudioData(await response.arrayBuffer());
    const events: Array<{
      duration: number;
      position?: { x: number; z: number; model: string; rolloff: number };
    }> = JSON.parse(document.documentElement.dataset['audioEvents'] ?? '[]');
    return events
      .filter((event) => Math.abs(event.duration - sample.duration) < 0.00001)
      .map((event) => event.position);
  }, name);
}

test.each([1280, 390])(
  'nearby crew shots and mining have independent HRTF directions at %i pixels',
  async (width) => {
    const listenerPage = browserManager.getCurrentPage();
    assert.ok(listenerPage);
    const shooterPage = await browserManager.createAdditionalPage();
    await listenerPage.setViewportSize({ width, height: 900 });
    const diagnostics = [
      watchBrowserDiagnostics(listenerPage),
      watchBrowserDiagnostics(shooterPage),
    ];
    await installAudioProbe(listenerPage);
    const listener = new GameInteractions(listenerPage);
    const shooter = new GameInteractions(shooterPage);
    await listener.bootGame({ waitForCombatReady: false });
    await shooter.bootGame({ kitId: 'scout', waitForCombatReady: false });
    const ids = await Promise.all([listener.getLocalPlayerId(), shooter.getLocalPlayerId()]);
    await arrangeCrewField(ids, 'empty');
    await Promise.all([listener.waitForCombatReady(), shooter.waitForCombatReady()]);
    // Wait for the two samples this scenario uses, not the global bank size.
    const requiredDurations = await listenerPage.evaluate(() => {
      const context = new OfflineAudioContext(2, 1, 48000);
      return Promise.all(
        ['laser', 'asteroid-explode'].map(async (name) => {
          const response = await fetch(`/sounds/${name}.m4a`);
          const buffer = await context.decodeAudioData(await response.arrayBuffer());
          return buffer.duration;
        })
      );
    });
    await expect
      .poll(() =>
        listenerPage.evaluate((durations) => {
          const decoded: number[] = JSON.parse(
            document.documentElement.dataset['decodedAudioDurations'] ?? '[]'
          );
          return durations.every((duration) =>
            decoded.some((value) => Math.abs(value - duration) < 0.00001)
          );
        }, requiredDurations)
      )
      .toBe(true);
    const listenerId = ids[0];
    assert.ok(listenerId);
    await shooter.fireLaserAtRemotePlayer(listenerId, 110);
    await expect.poll(async () => (await positionsForSample(listenerPage, 'laser')).length).toBe(1);
    await shooter.fireLaserAtRemotePlayer(listenerId, -110);
    await expect.poll(async () => (await positionsForSample(listenerPage, 'laser')).length).toBe(2);
    const shots = await positionsForSample(listenerPage, 'laser');
    expect(shots[0]?.x).toBeLessThan(0);
    expect(shots[1]?.x).toBeGreaterThan(0);
    expect(shots.every((position) => position?.model === 'HRTF' && position.rolloff === 0)).toBe(
      true
    );

    await arrangeCrewField(ids, 'mining');
    await listener.placeShipAt(120, -460);
    const rock = (await shooter.getAsteroidPositions()).find(
      (asteroid) => asteroid.id === 'crew-fixture-ore'
    );
    assert.ok(rock);
    await shooter.destroyAsteroidWithLaser(rock);
    await expect
      .poll(async () => (await positionsForSample(listenerPage, 'asteroid-explode')).length)
      .toBe(1);
    const [impact] = await positionsForSample(listenerPage, 'asteroid-explode');
    expect(impact?.x).toBeLessThan(0);
    expect(impact?.model).toBe('HRTF');
    await listenerPage.screenshot({
      path: screenshotManager.getScreenshotPath(`spatial-audio-${width}.png`),
    });
    for (const diagnostic of diagnostics) {
      assertNoBrowserDiagnostics(diagnostic);
    }
  },
  TestConfig.DEFAULT_TIMEOUT * 2
);

test(
  'the shipped laser renders louder in the nearer ear with native HRTF',
  async () => {
    const page = browserManager.getCurrentPage();
    assert.ok(page);
    await page.goto(TestConfig.GAME_URL);
    const energies = await page.evaluate(async () => {
      const bytes = await (await fetch('/sounds/laser.m4a')).arrayBuffer();
      const results: number[][] = [];
      for (const x of [-2, 2]) {
        const context = new OfflineAudioContext(2, 48000, 48000);
        const source = context.createBufferSource();
        source.buffer = await context.decodeAudioData(bytes.slice(0));
        const pan = context.createPanner();
        pan.panningModel = 'HRTF';
        pan.rolloffFactor = 0;
        pan.positionX.value = x;
        pan.positionZ.value = -1;
        source.connect(pan).connect(context.destination);
        source.start(0.1);
        const rendered = await context.startRendering();
        results.push(
          [0, 1].map((channel) =>
            rendered.getChannelData(channel).reduce((sum, value) => sum + value * value, 0)
          )
        );
      }
      return results;
    });
    const left = energies[0];
    const right = energies[1];
    assert.ok(left?.[0] && left[1] && right?.[0] && right[1]);
    expect(left[0]).toBeGreaterThan(left[1] * 1.2);
    expect(right[1]).toBeGreaterThan(right[0] * 1.2);
  },
  TestConfig.DEFAULT_TIMEOUT
);
