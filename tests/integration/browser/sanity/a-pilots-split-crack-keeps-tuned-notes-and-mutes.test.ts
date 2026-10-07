// @vitest-environment node
import { writeFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { installAudioProbe } from '../../utils/audio-probe';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { withFixtureEvidence } from '../../utils/fixture-evidence';
import { GameInteractions } from '../../utils/game-interactions';
import {
  installOfflineAudioObservation,
  readOfflineAudioObservation,
} from '../../utils/offline-audio-observation';

const { browserManager, screenshotManager, ownCleanup } = createBrowserScenarioHooks();

for (const viewport of [
  { name: 'desktop', width: 1280, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
]) {
  test(`${viewport.name} split crack keeps tuned notes and muting silences its admitted native graph`, async () => {
    const page = await browserManager.recreatePage({ hasTouch: viewport.name === 'mobile' });
    await page.setViewportSize(viewport);
    const errors: string[] = [];
    const warnings: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') {
        errors.push(message.text());
      }
      if (message.type() === 'warning') {
        warnings.push(message.text());
      }
    });
    await installAudioProbe(page);
    await installOfflineAudioObservation(page);
    ownCleanup(() =>
      withFixtureEvidence(page, `offline-split-${viewport.name}`, async () => {}, {
        evidence: () => readOfflineAudioObservation(page),
      })
    );
    await new GameInteractions(page).navigateToGame();
    const selected = page.locator('#ship-kit-grid [aria-pressed="true"]');
    if (viewport.name === 'mobile') {
      await selected.tap();
    } else {
      await selected.click();
    }
    await expect
      .poll(() => page.evaluate(() => document.documentElement.dataset['audioContextState']))
      .toBe('running');
    // A native browser import avoids Vitest rewriting dynamic imports inside evaluate.
    const splits: Array<{ rate: number; starts: number[]; ends: number[]; peak: number }> =
      await page.evaluate(`(async () => {
      const { synthesizeSplitCrack } = await import('/src/audio/splitSound.ts');
      const results = [];
      for (const random of [0, 0.999999]) {
        const context = new OfflineAudioContext(1, 24000, 48000);
        const starts = [], ends = [], sources = [];
        const createOscillator = context.createOscillator.bind(context);
        context.createOscillator = () => {
          const oscillator = createOscillator();
          const start = oscillator.frequency.setValueAtTime.bind(oscillator.frequency);
          const end = oscillator.frequency.exponentialRampToValueAtTime.bind(oscillator.frequency);
          oscillator.frequency.setValueAtTime = (value, at) => { starts.push(value); return start(value, at); };
          oscillator.frequency.exponentialRampToValueAtTime = (value, at) => { ends.push(value); return end(value, at); };
          return oscillator;
        };
        const createSource = context.createBufferSource.bind(context);
        context.createBufferSource = () => { const source = createSource(); sources.push(source); return source; };
        const originalRandom = Math.random;
        try {
          Math.random = () => random;
          if (!synthesizeSplitCrack(1, context)) throw new Error('Native split graph was not admitted');
        } finally { Math.random = originalRandom; }
        const rendered = await context.startRendering();
        const peak = rendered.getChannelData(0).reduce((peak, value) => Math.max(peak, Math.abs(value)), 0);
        results.push({ rate: sources[0].playbackRate.value, starts, ends, peak });
      }
      return results;
    })()`);
    for (const [index, split] of splits.entries()) {
      const rate = index === 0 ? 0.9 : 1.1;
      expect(split.rate).toBeCloseTo(rate);
      expect(split.starts[0]).toBeCloseTo(196, 2);
      expect(split.starts[1]).toBeCloseTo(130.8128, 2);
      expect(split.ends[0]).toBeCloseTo(130.8128, 2);
      expect(split.ends[1]).toBeCloseTo(65.4064, 2);
      expect(split.peak).toBeGreaterThan(0);
    }
    const mutedSplitPeak = await page.evaluate(`(async () => {
      const { synthesizeSplitCrack } = await import('/src/audio/splitSound.ts');
      const { setSound } = await import('/src/audio/Sound.ts');
      const context = new OfflineAudioContext(1, 24000, 48000);
      setSound(true);
      if (!synthesizeSplitCrack(1, context)) throw new Error('Native muted split graph was not admitted');
      setSound(false);
      const rendered = await context.startRendering();
      return rendered.getChannelData(0).reduce((peak, value) => Math.max(peak, Math.abs(value)), 0);
    })()`);
    expect(mutedSplitPeak).toBe(0);
    writeFileSync(
      screenshotManager.getScreenshotPath(`offline-split-${viewport.name}-receipt.json`),
      JSON.stringify({ splits, mutedSplitPeak, errors, warnings }, null, 2)
    );
    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
  }, 60000);
}
