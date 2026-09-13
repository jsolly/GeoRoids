import { readdirSync, writeFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { installAudioProbe } from '../../utils/audio-probe';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';

const { browserManager, screenshotManager } = createBrowserScenarioHooks();

for (const viewport of [
  { name: 'desktop', width: 1280, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
]) {
  test(`${viewport.name} pilot hears varied shots and thrust, then mutes every cue`, async () => {
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
    const game = new GameInteractions(page);
    await game.bootGame();
    for (let shot = 0; shot < 3; shot++) {
      await page.keyboard.press('Space');
      await page.waitForTimeout(500);
    }
    await expect
      .poll(async () =>
        page.evaluate(() => {
          const events = JSON.parse(document.documentElement.dataset['audioEvents'] ?? '[]');
          return events.filter((event: { src: string }) => event.src.endsWith('/laser.m4a')).length;
        })
      )
      .toBeGreaterThanOrEqual(3);
    await page.keyboard.up('Space');
    await page.keyboard.down('ArrowUp');
    await expect
      .poll(async () =>
        page.evaluate(() => {
          return (document.documentElement.dataset['audioEvents'] ?? '').includes('/thrust.m4a');
        })
      )
      .toBe(true);
    await page.keyboard.up('ArrowUp');
    const events: Array<{ src: string; rate: number; preservesPitch: boolean }> =
      await page.evaluate(() =>
        JSON.parse(document.documentElement.dataset['audioEvents'] ?? '[]')
      );
    for (const event of events) {
      expect(event.rate).toBeGreaterThanOrEqual(0.9);
      expect(event.rate).toBeLessThanOrEqual(1.1);
      expect(event.preservesPitch).toBe(false);
    }
    expect(
      new Set(events.filter((event) => event.src.endsWith('/laser.m4a')).map((event) => event.rate))
        .size
    ).toBeGreaterThan(1);

    // Decode every shipped sample with the real browser's codec, not a media mock.
    const assets = readdirSync('public/sounds').filter((name) => name.endsWith('.m4a'));
    const decoded = await page.evaluate(async (names) => {
      const context = new AudioContext();
      try {
        return await Promise.all(
          names.map(async (name) => {
            const response = await fetch(`/sounds/${name}`);
            if (!response.ok) {
              throw new Error(`Missing sound ${name}`);
            }
            const buffer = await context.decodeAudioData(await response.arrayBuffer());
            return {
              name,
              duration: buffer.duration,
              peak: buffer
                .getChannelData(0)
                .reduce((peak, value) => Math.max(peak, Math.abs(value)), 0),
            };
          })
        );
      } finally {
        await context.close();
      }
    }, assets);
    for (const sample of decoded) {
      expect(sample.duration).toBeGreaterThan(0);
      expect(sample.peak).toBeGreaterThan(0);
    }
    // The title-screen checkbox is hidden during play; exercise its real change handler.
    await page.locator('#soundPref').evaluate((input) => {
      if (!(input instanceof HTMLInputElement)) {
        throw new Error('Sound preference checkbox missing');
      }
      input.checked = false;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await expect
      .poll(() => page.evaluate(() => document.documentElement.dataset['activeAudio']))
      .toBe('0');
    const countAfterMute = await page.evaluate(
      () => document.documentElement.dataset['audioEvents']
    );
    await page.keyboard.down('Space');
    await page.waitForTimeout(500);
    await page.keyboard.up('Space');
    expect(await page.evaluate(() => document.documentElement.dataset['audioEvents'])).toBe(
      countAfterMute
    );
    await page.screenshot({
      path: screenshotManager.getScreenshotPath(`audio-${viewport.name}.png`),
    });
    await page.goto(new URL('/wiki/#hud-network', page.url()).href);
    await expect.poll(() => page.locator('body').textContent()).toContain('pitch');
    await page.screenshot({
      path: screenshotManager.getScreenshotPath(`audio-wiki-${viewport.name}.png`),
    });
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
          synthesizeSplitCrack(1, context);
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
      expect(split.starts[0]).toBeCloseTo(880 * rate, 2);
      expect(split.starts[1]).toBeCloseTo(180 * rate, 2);
      expect(split.ends[0]).toBeCloseTo(220 * rate, 2);
      expect(split.ends[1]).toBeCloseTo(70 * rate, 2);
      expect(split.peak).toBeGreaterThan(0);
    }
    const mutedSplitPeak = await page.evaluate(`(async () => {
      const { synthesizeSplitCrack } = await import('/src/audio/splitSound.ts');
      const { setSound } = await import('/src/audio/Sound.ts');
      const context = new OfflineAudioContext(1, 24000, 48000);
      setSound(true);
      synthesizeSplitCrack(1, context);
      setSound(false);
      const rendered = await context.startRendering();
      return rendered.getChannelData(0).reduce((peak, value) => Math.max(peak, Math.abs(value)), 0);
    })()`);
    expect(mutedSplitPeak).toBe(0);
    writeFileSync(
      screenshotManager.getScreenshotPath(`audio-${viewport.name}-receipt.json`),
      JSON.stringify({ events, decoded, splits, mutedSplitPeak, errors, warnings }, null, 2)
    );
    expect(errors).toEqual([]);
  }, 60000);
}
